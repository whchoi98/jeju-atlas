import test from 'node:test';
import assert from 'node:assert/strict';

let buildGuideMessage;
try {
  ({ buildGuideMessage } = await import('../src/guide-context.ts'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

const context = '선택 장소 협재해변. 지도 중심 33.3800, 126.5600. 내 코스 김녕미로공원, 비자림.';

test('broad family and indoor questions do not inherit a map radius or saved itinerary', () => {
  assert.equal(typeof buildGuideMessage, 'function');
  for (const message of [
    '아이와 함께 방문할 장소를 추천하고 편의 정보가 확인되는지 알려 주세요.',
    '제주에서 비 오는 날 둘러보기 좋은 실내 장소를 알려 주세요.',
    '제주 동쪽에서 자연을 즐기는 반나절 코스를 추천해 주세요.',
  ]) {
    assert.equal(buildGuideMessage(message, context), message);
  }
});

test('a named destination has precedence over an unrelated camera or selection', () => {
  assert.equal(typeof buildGuideMessage, 'function');
  const message = '성산일출봉 근처 카페를 추천해 주세요.';
  assert.equal(buildGuideMessage(message, context), message);
});

test('explicit references to the current map or selected place retain context', () => {
  assert.equal(typeof buildGuideMessage, 'function');
  for (const message of ['현재 지도 주변의 카페를 찾아 주세요.', '선택한 장소의 편의 정보를 알려 주세요.', '여기 근처 맛집은?']) {
    const result = buildGuideMessage(message, context);
    assert.ok(result.startsWith(message));
    assert.ok(result.includes(context));
  }
});

test('an explicit saved itinerary reference retains its stops', () => {
  assert.equal(typeof buildGuideMessage, 'function');
  assert.match(buildGuideMessage('내 코스에 실내 장소도 추가해 주세요.', context), /김녕미로공원, 비자림/);
});

test('empty context and bounded messages stay within the guide API contract', () => {
  assert.equal(typeof buildGuideMessage, 'function');
  assert.equal(buildGuideMessage(' 여기 근처 알려 주세요. ', ''), '여기 근처 알려 주세요.');
  const result = buildGuideMessage('현재 지도 주변 '.repeat(200), context.repeat(50));
  assert.ok(result.length <= 2000);
  assert.ok(result.startsWith('현재 지도 주변'));
});
test('a broad or named 2000-character question is not truncated to make unused context space', () => {
  const question = 'Restaurants near Hallasan? ' + 'x'.repeat(2000 - 'Restaurants near Hallasan? '.length);
  assert.equal(buildGuideMessage(question, 'Map center 33.4, 126.5.', 'en'), question);
});
