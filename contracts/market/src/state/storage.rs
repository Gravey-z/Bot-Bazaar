use super::*;
use near_sdk::AccountId;

impl RetainedIds {
    fn append(&mut self, id: u64) -> Option<u64> {
        let head = usize::from(self.head);
        if usize::from(self.count) == RETAINED_HISTORY {
            let evicted = self.slots[head].replace(id);
            self.head = ((head + 1) % RETAINED_HISTORY) as u8;
            evicted
        } else {
            let tail = (head + usize::from(self.count)) % RETAINED_HISTORY;
            self.slots[tail] = Some(id);
            self.count += 1;
            None
        }
    }
}

impl MarketState {
    pub fn ensure_running(&self) -> Result<(), StateError> {
        if self.paused {
            return Err(StateError::MarketPaused);
        }
        Ok(())
    }

    pub fn add_player(&mut self, account_id: AccountId) -> Result<(), StateError> {
        self.ensure_running()?;
        if self.players.contains_key(&account_id) {
            return Err(StateError::AlreadyRegistered);
        }
        if self.registered_player_count >= MAX_PLAYERS {
            return Err(StateError::PlayerCapacity);
        }
        let count = checked_increment(self.registered_player_count)?;
        let issued = checked_credit(self.total_issued_gold, STARTER_GOLD, u64::MAX)?;
        let player = Player {
            account_id: account_id.clone(),
            balances: Balances::new(STARTER_GOLD, Inventory::default())?,
        };
        self.players.insert(account_id, player);
        self.registered_player_count = count;
        self.total_issued_gold = issued;
        Ok(())
    }

    pub fn insert_pending_offer(&mut self, offer: Offer) -> Result<(), StateError> {
        self.ensure_running()?;
        if offer.offer_id != self.offer_ids.next_id()
            || self.offers.contains_key(&offer.offer_id)
            || offer.status != OfferStatus::Pending
            || offer.buyer == offer.seller
            || ![offer.buyer, offer.seller].contains(&offer.proposer)
            || offer.counterparty
                != if offer.proposer == offer.buyer {
                    offer.seller
                } else {
                    offer.buyer
                }
            || offer.closed_at_ns.is_some()
            || offer.settled_trade_id.is_some()
        {
            return Err(StateError::InvalidRecord);
        }
        let buyer = offer.buyer.index();
        let seller = offer.seller.index();
        if [buyer, seller]
            .iter()
            .any(|index| self.merchants[*index].pending_offer_count >= MAX_PENDING_PER_MERCHANT)
        {
            return Err(StateError::OfferCapacity);
        }
        let slot = self
            .pending_offer_ids
            .iter()
            .position(Option::is_none)
            .ok_or(StateError::OfferCapacity)?;
        checked_increment(self.offer_ids.next_id())?;
        self.offer_ids.allocate()?;
        self.pending_offer_ids[slot] = Some(offer.offer_id);
        self.merchants[buyer].pending_offer_count += 1;
        self.merchants[seller].pending_offer_count += 1;
        self.offers.insert(offer.offer_id, offer);
        Ok(())
    }

    pub fn close_offer(
        &mut self,
        offer_id: u64,
        status: OfferStatus,
        now: u64,
        settled_trade_id: Option<u64>,
    ) -> Result<(), StateError> {
        if status == OfferStatus::Accepted {
            self.ensure_running()?;
        }
        let offer = self
            .offers
            .get(&offer_id)
            .ok_or(StateError::InvalidTransition)?;
        if offer.status != OfferStatus::Pending
            || status == OfferStatus::Pending
            || (status == OfferStatus::Expired) != (now >= offer.expires_at_ns)
            || (status == OfferStatus::Accepted) != settled_trade_id.is_some()
            || settled_trade_id == Some(0)
        {
            return Err(StateError::InvalidTransition);
        }
        let slot = self
            .pending_offer_ids
            .iter()
            .position(|id| *id == Some(offer_id))
            .ok_or(StateError::InvalidRecord)?;
        let buyer = offer.buyer.index();
        let seller = offer.seller.index();
        if buyer == seller
            || self.merchants[buyer].pending_offer_count == 0
            || self.merchants[seller].pending_offer_count == 0
        {
            return Err(StateError::InvalidRecord);
        }
        let closed_at = if status == OfferStatus::Expired {
            offer.expires_at_ns
        } else {
            now
        };
        self.pending_offer_ids[slot] = None;
        self.merchants[buyer].pending_offer_count -= 1;
        self.merchants[seller].pending_offer_count -= 1;
        if let Some(evicted) = self.terminal_offer_ids.append(offer_id) {
            self.offers.remove(&evicted);
            self.offers_pruned_through = self.offers_pruned_through.max(evicted);
        }
        let offer = self
            .offers
            .get_mut(&offer_id)
            .ok_or(StateError::InvalidRecord)?;
        offer.status = status;
        offer.closed_at_ns = Some(closed_at);
        offer.settled_trade_id = settled_trade_id;
        Ok(())
    }

    pub fn append_trade(&mut self, trade: Trade) -> Result<(), StateError> {
        self.ensure_running()?;
        if trade.trade_id != self.trade_ids.next_id() || self.trades.contains_key(&trade.trade_id) {
            return Err(StateError::InvalidRecord);
        }
        checked_increment(self.trade_ids.next_id())?;
        self.trade_ids.allocate()?;
        if let Some(evicted) = self.trade_history_ids.append(trade.trade_id) {
            self.trades.remove(&evicted);
            self.trades_pruned_through = self.trades_pruned_through.max(evicted);
        }
        self.trades.insert(trade.trade_id, trade);
        Ok(())
    }

    pub fn expire_offers(
        &mut self,
        ids: &[u64],
        now: u64,
    ) -> Result<(Vec<u64>, Vec<u64>), StateError> {
        if ids.is_empty()
            || ids.len() > MAX_EXPIRE_BATCH as usize
            || ids.contains(&0)
            || ids
                .iter()
                .enumerate()
                .any(|(index, id)| ids[..index].contains(id))
        {
            return Err(StateError::InvalidBatch);
        }
        let mut expired = Vec::new();
        let mut ignored = Vec::new();
        let mut releasing = [0_u8; 3];
        for id in ids {
            if let Some(offer) = self.offers.get(id)
                && offer.status == OfferStatus::Pending
                && now >= offer.expires_at_ns
            {
                if !self.pending_offer_ids.contains(&Some(*id)) || offer.buyer == offer.seller {
                    return Err(StateError::InvalidRecord);
                }
                releasing[offer.buyer.index()] += 1;
                releasing[offer.seller.index()] += 1;
                expired.push(*id);
            } else {
                ignored.push(*id);
            }
        }
        for (index, count) in releasing.into_iter().enumerate() {
            if count > self.merchants[index].pending_offer_count {
                return Err(StateError::InvalidRecord);
            }
        }
        if !expired.is_empty() {
            let revision = checked_increment(self.market_revision)?;
            for id in &expired {
                self.close_offer(*id, OfferStatus::Expired, now, None)?;
            }
            self.market_revision = revision;
        }
        Ok((expired, ignored))
    }
}

#[cfg(test)]
mod tests;
