import type { HoursRow } from '../shared/api-types';

export function facilityText(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (['', 'unknown', '미확인', '정보 없음', 'n/a'].includes(normalized)) return '미확인';
  if (normalized === 'yes') return '자료상 있음';
  if (normalized === 'no') return '자료상 없음';
  return value;
}

export function hasFacilityRecord(value: string): boolean {
  return facilityText(value) !== '미확인';
}

export function hoursText(hours: HoursRow[], source: string | null): string {
  if (!hours.length) return '요일별 영업시간 미확인';
  if (source === 'tourapi_usetime') {
    const windows = [...new Set(hours.map((hour) => `${hour.open}–${hour.close}`))].join(', ');
    return `이용시간 문구에서 추출: ${windows} · 휴무일 미확인`;
  }
  return `요일별 영업시간 ${hours.length}건 등록`;
}
