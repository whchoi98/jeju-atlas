export type Category = 'mountain' | 'coast' | 'island';

export interface Place {
  id: string;
  name: string;
  english: string;
  category: Category;
  coordinates: [number, number];
  description: string;
  detail: string;
  location: string;
  zoom: number;
  bearing: number;
  elevation?: number;
}

export const categories: Record<Category, string> = {
  mountain: '산·오름',
  coast: '해안',
  island: '섬',
};

// Landmark centers, in [longitude, latitude]. These describe the view, not trail
// entrances or navigable routes. Descriptions deliberately avoid access advice.
export const places: Place[] = [
  {
    id: 'hallasan',
    name: '한라산',
    english: 'Hallasan',
    category: 'mountain',
    coordinates: [126.5292, 33.3617],
    description: '섬의 중심에서 만나는 제주의 가장 높은 풍경',
    detail: '백록담을 품은 정상에서 사방으로 이어지는 능선. 시점을 기울여 제주의 중심을 입체적으로 둘러보세요.',
    location: '제주 중심부',
    zoom: 12.5,
    bearing: -24,
    elevation: 1947,
  },
  {
    id: 'seongsan',
    name: '성산일출봉',
    english: 'Seongsan Ilchulbong',
    category: 'mountain',
    coordinates: [126.9425, 33.4581],
    description: '바다 곁으로 솟아오른 둥근 분화구',
    detail: '제주 동쪽 해안의 성산일출봉. 바다와 맞닿은 분화구의 윤곽을 위에서, 옆에서 살펴보세요.',
    location: '서귀포시 성산읍',
    zoom: 14.3,
    bearing: -40,
  },
  {
    id: 'hyeopjae',
    name: '협재해변',
    english: 'Hyeopjae Beach',
    category: 'coast',
    coordinates: [126.2391, 33.3943],
    description: '비양도를 마주한 서쪽 바다의 곡선',
    detail: '협재의 해안선 너머로 비양도가 보입니다. 바다와 모래, 섬이 만나는 서쪽 해안을 따라 움직여 보세요.',
    location: '제주시 한림읍',
    zoom: 13.3,
    bearing: 25,
  },
  {
    id: 'udo',
    name: '우도',
    english: 'Udo Island',
    category: 'island',
    coordinates: [126.9537, 33.5041],
    description: '제주 동쪽, 바다 안에 놓인 또 하나의 섬',
    detail: '제주 본섬의 동쪽에 자리한 우도. 섬의 해안선을 한 바퀴 따라가며 남쪽의 우도봉을 찾아보세요.',
    location: '제주시 우도면',
    zoom: 12.6,
    bearing: -15,
  },
  {
    id: 'sanbangsan',
    name: '산방산',
    english: 'Sanbangsan',
    category: 'mountain',
    coordinates: [126.3134, 33.2414],
    description: '남서쪽 들판 위로 우뚝 솟은 산',
    detail: '평평한 주변 지형과 뚜렷한 대비를 이루는 산방산. 가까이에서 솟아오른 산의 형태를 살펴보세요.',
    location: '서귀포시 안덕면',
    zoom: 13.5,
    bearing: -25,
  },
  {
    id: 'hamdeok',
    name: '함덕해변',
    english: 'Hamdeok Beach',
    category: 'coast',
    coordinates: [126.6692, 33.5431],
    description: '서우봉 아래로 이어지는 북쪽 해안',
    detail: '북동쪽 해안의 함덕해변과 그 곁의 서우봉. 완만한 해안선과 오름이 만나는 풍경을 둘러보세요.',
    location: '제주시 조천읍',
    zoom: 13.4,
    bearing: 15,
  },
  {
    id: 'sangumburi',
    name: '산굼부리',
    english: 'Sangumburi',
    category: 'mountain',
    coordinates: [126.6931, 33.4321],
    description: '중산간에 움푹 열린 분화구의 윤곽',
    detail: '제주 중산간에 자리한 산굼부리. 고도 배율을 조절하며 주변 지형과 분화구의 높낮이를 비교해 보세요.',
    location: '제주시 조천읍',
    zoom: 14,
    bearing: -35,
  },
  {
    id: 'jusangjeolli',
    name: '대포 주상절리',
    english: 'Daepo Jusangjeolli',
    category: 'coast',
    coordinates: [126.4251, 33.2378],
    description: '제주 남쪽 바다와 맞닿은 용암 해안',
    detail: '중문·대포 해안의 주상절리대. 해안의 위치와 주변 지형을 살펴보세요. 개별 바위의 형태는 지형 해상도에 따라 생략됩니다.',
    location: '서귀포시 중문동',
    zoom: 14,
    bearing: -8,
  },
  {
    id: 'bija',
    name: '비양도',
    english: 'Biyangdo Island',
    category: 'island',
    coordinates: [126.2292, 33.4068],
    description: '협재 앞바다에 떠 있는 작은 화산섬',
    detail: '한림 앞바다에 자리한 비양도. 섬의 중심에 솟은 비양봉과 둘레의 해안을 한눈에 살펴보세요.',
    location: '제주시 한림읍',
    zoom: 14,
    bearing: 15,
  },
  {
    id: 'songaksan',
    name: '송악산',
    english: 'Songaksan',
    category: 'mountain',
    coordinates: [126.2902, 33.1991],
    description: '제주 남서쪽 끝에서 마주하는 분화구와 바다',
    detail: '바다로 뻗은 송악산과 주변 해안. 시야를 넓혀 산방산에서 이어지는 남서쪽 지형을 함께 둘러보세요.',
    location: '서귀포시 대정읍',
    zoom: 13.8,
    bearing: -25,
  },
  {
    id: 'seopjikoji',
    name: '섭지코지',
    english: 'Seopjikoji',
    category: 'coast',
    coordinates: [126.9275, 33.4239],
    description: '동쪽 바다로 길게 뻗은 해안의 끝',
    detail: '성산일출봉 남쪽으로 이어지는 섭지코지. 바다 쪽으로 돌출된 해안의 모양을 지도로 따라가 보세요.',
    location: '서귀포시 성산읍',
    zoom: 13.8,
    bearing: -25,
  },
  {
    id: 'gapado',
    name: '가파도',
    english: 'Gapado Island',
    category: 'island',
    coordinates: [126.2715, 33.1706],
    description: '제주 남쪽, 바다 가까이 낮게 펼쳐진 섬',
    detail: '모슬포 남쪽 바다의 가파도. 제주 본섬의 산지와 나란히 비교하며 낮고 완만한 섬의 지형을 살펴보세요.',
    location: '서귀포시 대정읍',
    zoom: 13.4,
    bearing: -15,
  },
];

export const tourStops = ['hallasan', 'seongsan', 'udo', 'hyeopjae', 'sanbangsan'];

export function formatCoordinates(coordinates: [number, number]): string {
  return `${coordinates[1].toFixed(4)}° N  ${coordinates[0].toFixed(4)}° E`;
}
