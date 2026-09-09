// A camera is a browsing state, not an implicit "within 5 km" request.
// Only attach it when the question actually refers to the map or saved trip.
export function buildGuideMessage(message: string, context = ''): string {
  const question = message.trim().slice(0, 1800);
  const refersToView = /여기|이\s*곳|이\s*주변|이\s*근처|선택(?:한)?\s*(?:장소|곳)|현재\s*지도|지도\s*(?:중심|주변|근처|화면)|화면\s*(?:주변|근처)/.test(question);
  const refersToTrip = /(?:내|저장한|담은)\s*(?:여행|코스|일정)/.test(question);
  if (!question || !context.trim() || (!refersToView && !refersToTrip)) return question;
  return `${question}\n\n사용자가 가리킨 탐색 맥락: ${context.trim()}`.slice(0, 2000);
}
