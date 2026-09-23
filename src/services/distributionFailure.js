// Only explicit rejections are safe to label as not sent. Timeouts remain uncertain.
function failureState(error) {
  const message = String(error?.message || error || '');
  return /está sem Profile Key da Ayrshare|Meta is requesting additional identity verification for this account/i.test(message)
    ? 'blocked' : 'uncertain';
}
module.exports = { failureState };
