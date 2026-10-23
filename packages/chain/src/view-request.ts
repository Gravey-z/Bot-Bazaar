export interface FinalizedViewRequest {
  jsonrpc: "2.0";
  id: "bot-bazaar-view";
  method: "query";
  params: {
    request_type: "call_function";
    finality: "final";
    account_id: string;
    method_name: string;
    args_base64: string;
  };
}

export function createViewRequest(
  contractId: string,
  methodName: string,
  args: Readonly<Record<string, unknown>> = {},
): FinalizedViewRequest {
  if (!contractId || !methodName) {
    throw new Error("A contract ID and view method are required");
  }
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return {
    jsonrpc: "2.0",
    id: "bot-bazaar-view",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: methodName,
      args_base64: btoa(binary),
    },
  };
}
