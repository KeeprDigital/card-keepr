export async function reconcileConsumerInstallation({
  replacementName,
  markerName,
  putReplacement,
  putMarker,
  verify,
  recordMutation,
}) {
  if (!(await putReplacement())) return false;
  recordMutation(`consumer-secret-put:${replacementName}`);
  if (!(await putMarker())) return false;
  recordMutation(`consumer-marker-put:${markerName}`);
  return verify();
}
