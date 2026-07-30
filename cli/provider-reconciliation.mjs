export async function reconcileConsumerInstallation({
  replacementName,
  markerName,
  putReplacement,
  putMarker,
  verify,
  recordMutation,
}) {
  recordMutation(`consumer-secret-put:${replacementName}`);
  if (!(await putReplacement())) return false;
  recordMutation(`consumer-marker-put:${markerName}`);
  if (!(await putMarker())) return false;
  return verify();
}
