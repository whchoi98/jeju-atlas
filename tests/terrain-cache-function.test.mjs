import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

// Execute the actual CloudFront function from the deployable template.
// This catches cacheable error responses and lost headers, not template text.
const code = execFileSync('python3', ['-c', `
from pathlib import Path
import yaml
template = yaml.load(Path("infra/application.yaml").read_text(), Loader=yaml.BaseLoader)
print(template["Resources"].get("TerrainBrowserCacheFunction", {}).get("Properties", {}).get("FunctionCode", ""))
`], { encoding: 'utf8' });

test('terrain cache response policy handles success, revalidation and failures', () => {
  assert.ok(code.trim(), 'A status-aware tile response function is required');
  const context = vm.createContext({});
  vm.runInContext(code, context);
  for (const [statusCode, expected] of [
    [200, 'public, max-age=86400'],
    [206, 'public, max-age=86400'],
    [304, 'public, max-age=86400'],
    [403, 'no-store'],
    [404, 'no-store'],
    [500, 'no-store'],
    [503, 'no-store'],
  ]) {
    const response = {
      statusCode,
      headers: {
        'cache-control': { value: 'no-store' },
        'content-type': { value: 'image/png' },
        'access-control-allow-origin': { value: '*' },
        etag: { value: '"unchanged-tile"' },
      },
    };
    const result = context.handler({ response });
    assert.equal(result.statusCode, statusCode);
    assert.equal(result.headers['cache-control'].value, expected, `status ${statusCode}`);
    assert.equal(result.headers.etag.value, '"unchanged-tile"');
    assert.equal(result.headers['access-control-allow-origin'].value, '*');
  }
});
