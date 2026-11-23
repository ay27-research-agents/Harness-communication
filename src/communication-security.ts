/** These fields describe delivery, not the correctness of message content. */
export function communicationSecurity(receipt: {mode?: unknown} | undefined) {
  const localSocket = receipt?.mode === 'socket';
  const inline = receipt?.mode === 'inline';
  return {
    source: 'harness-delivery-record',
    transport: localSocket ? 'local-tcp' : inline ? 'in-process' : 'unknown',
    encryption: localSocket ? 'none' : inline ? 'not-applicable' : 'unknown',
    certificateVerification: localSocket || inline ? 'not-used' : 'unknown',
    messageSignature: 'not-present',
  } as const;
}
