// A camera is a browsing state, not an implicit "within 5 km" request.
// Only attach it when the question actually refers to the map or saved trip.
export function buildGuideMessage(message: string, context = '', locale: 'ko' | 'en' = 'ko'): string {
  const question = message.trim().slice(0, 2000);
  const refersToView = /여기|이\s*곳|이\s*주변|이\s*근처|선택(?:한)?\s*(?:장소|곳)|현재\s*지도|지도\s*(?:중심|주변|근처|화면)|화면\s*(?:주변|근처)|current map|map cent(?:er|re)|selected (?:place|location)|this (?:place|area)|around here/i.test(question);
  const refersToTrip = /(?:내|저장한|담은)\s*(?:여행|코스|일정)|(?:my|saved) (?:trip|itinerary|route)/i.test(question);
  if (!question || !context.trim() || (!refersToView && !refersToTrip)) return question;
  return `${question}\n\n${locale === 'en' ? 'Browsing context explicitly referenced by the user' : '사용자가 가리킨 탐색 맥락'}: ${context.trim()}`.slice(0, 2000);
}
