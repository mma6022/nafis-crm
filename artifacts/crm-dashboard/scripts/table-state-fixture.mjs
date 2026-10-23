import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const apiRequire = createRequire(path.resolve('../api-server/package.json'));
const { transformSync } = apiRequire('esbuild');
const React = require('react');
const { renderToString } = require('react-dom/server');
const { QueryClient } = require('@tanstack/react-query');
const client = new QueryClient();
client.setQueryDefaults(['table-view-state'], { gcTime: Infinity });
const location = { pathname: '/customers', search: '' };
const authKey = ['table-test-auth'];
const signIn = (id, role = 'admin') => client.setQueryData(authKey, { user: { id, role } });
const source = fs.readFileSync('src/hooks/use-table-state.ts', 'utf8');
const module = { exports: {} };
vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code, {
  module, exports: module.exports, window: { location },
  require: name => name === 'react' ? React :
    name === '@tanstack/react-query' ? { useQueryClient: () => client } :
    name === '@workspace/api-client-react' ? { getGetAuthSessionQueryKey: () => authKey } :
    require(name),
});
const { useTableState } = module.exports;
// Real React hook execution; a new server render models an unmount/remount.
function mount(field, initial) {
  let result;
  function List() { result = useTableState(field, initial); return null; }
  renderToString(React.createElement(List));
  return result;
}
signIn(1);
let [value, set] = mount('search', '');
assert.equal(value, '');
set('آزمون');
assert.equal(mount('search', '')[0], 'آزمون', 'back must restore search');
[, set] = mount('offset', 0);
set(n => n + 20); set(n => n + 20);
assert.equal(mount('offset', 0)[0], 40, 'batched functional updates retain page');
[, set] = mount('sort', undefined); set('desc');
assert.equal(mount('sort', undefined)[0], 'desc');
[, set] = mount('sort', undefined); set(undefined);
assert.equal(mount('sort', 'asc')[0], undefined, 'clearing sort stays cleared');
[, set] = mount('filters', {}); set({ status: 'pending', page: 3, sortDir: 'asc' });
assert.equal(mount('filters', {})[0].page, 3, 'compound wallet filters retained');
location.pathname = '/loan-applications';
assert.equal(mount('search', '')[0], '', 'lists isolated');
location.pathname = '/customers'; location.search = '?status=closed';
assert.equal(mount('search', '')[0], '', 'explicit deep links isolated');
location.search = '';
assert.equal(mount('search', '')[0], 'آزمون', 'browser back restores original list');
signIn(2);
assert.equal(mount('search', '')[0], '', 'accounts isolated');
signIn(1, 'salesperson');
assert.equal(mount('search', '')[0], '', 'role scopes isolated');
signIn(1);
assert.equal(mount('search', '')[0], 'آزمون');
client.clear(); signIn(1);
assert.equal(mount('search', '')[0], '', 'logout clears preferences');
client.clear();
console.log('PASS: navigation, pagination, sorting/reset, compound filters, deep links, actor/role isolation, logout');
