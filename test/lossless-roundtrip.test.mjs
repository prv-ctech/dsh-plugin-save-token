import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compressJsonText, compressJsonlText, uniformTabular, buildNotice } from '../src/compress.js'

const cfg = { jsonMaxParseBytes: 524288 }

// Independent decoder for the existing header/group + CSV-cell grammar.
// Quoted cells are strings; unquoted JSON scalar literals retain their types.
function cells(text) {
  const rows = [], row = []
  let value = '', quoted = false, wasQuoted = false
  function cell() {
    row.push(wasQuoted ? value : /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(value) ? JSON.parse(value) : value)
    value = ''; wasQuoted = false
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++ }
      else { quoted = !quoted; wasQuoted = true }
    } else if (!quoted && (c === ',' || c === '\n')) {
      cell()
      if (c === '\n') { rows.push(row.splice(0)) }
    } else value += c
  }
  assert.equal(quoted, false)
  cell(); rows.push(row)
  return rows
}

function decode(route) {
  let text = route.text, rest
  if (text.startsWith('{')) {
    const end = text.indexOf('\n')
    rest = JSON.parse(text.slice(0, end)); text = text.slice(end + 1)
  }
  const end = text.indexOf('\n')
  const header = text.slice(0, end).match(/^([^\[]+)\[(\d+)\]\{(.+)\}:$/)
  assert.ok(header)
  const groups = [...header[3].matchAll(/([^,{}]+)(?:\{([^{}]+)\})?/g)]
  const rows = cells(text.slice(end + 1)).map(values => {
    const row = {}; let column = 0
    for (const group of groups) {
      let value
      if (group[2]) value = Object.fromEntries(group[2].split(',').map(key => [key, values[column++]]))
      else value = values[column++]
      Object.defineProperty(row, group[1], { value, enumerable: true, writable: true, configurable: true })
    }
    assert.equal(column, values.length)
    return row
  })
  assert.equal(rows.length, Number(header[2]))
  if (route.strategy === 'toon-keyed') return Object.fromEntries(rows.map(({ key, ...value }) => [key, value]))
  if (rest !== undefined) {
    const path = header[1].split('.')
    let parent = rest
    for (const segment of path.slice(0, -1)) parent = parent[segment]
    Object.defineProperty(parent, path.at(-1), { value: rows, enumerable: true, writable: true, configurable: true })
    return rest
  }
  return rows
}

test('lossless semantic round trips: scalar types, whitespace, escapes, nested fields and locations', () => {
  const values = [null, 'null', true, 'true', 1, '1', '', '  padded  ', '1.0', '1e3', '-0', 'line\r\nnext', 'tab\tcell', 'say "yes", then', '中文', 'Infinity']
  const rows = values.map((value, i) => ({ id: i, value, position: { x: i / 10, label: values[(i + 1) % values.length] } }))
  for (const document of [rows, { items: rows }, { data: { items: rows }, other: { keep: true } }]) {
    const route = compressJsonText(JSON.stringify(document), cfg)
    assert.equal(route.lossless, true)
    assert.deepEqual(decode(route), document)
  }
  const route = compressJsonlText(rows.map(row => JSON.stringify(row)).join('\n'), cfg)
  assert.equal(route.lossless, true)
  assert.deepEqual(decode(route), rows)
})

test('keyed maps round trip reserved property names; notices disclose source shape', () => {
  const map = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['service' + i, JSON.parse('{"__proto__":"literal","value":' + i + '}')]))
  const keyed = compressJsonText(JSON.stringify(map), cfg)
  assert.equal(keyed.strategy, 'toon-keyed')
  assert.deepEqual(decode(keyed), map)
  for (const verbose of [false, true]) {
    for (const strategy of ['toon-keyed', 'jsonl']) {
      const notice = buildNotice({ body: 'table', id: 'c123', lossless: true, strategy, before: 1000, after: 100, locator: '/spill', verbose })
      assert.match(notice, strategy === 'toon-keyed' ? /keyed map.*key column/ : /JSONL.*one object/)
    }
  }
})

test('unsupported numeric spellings and unsafe names decline lossless routes', () => {
  for (const number of ['9007199254740993', '0.10000000000000001', '1e400', '-0', '1e3']) {
    const row = '{"n":' + number + ',"s":"9007199254740993 \\\" 1e400"}'
    const json = compressJsonText('[' + Array(8).fill(row).join(',') + ']', cfg)
    assert.ok(!json?.lossless, number)
    assert.equal(compressJsonlText(Array(8).fill(row).join('\n'), cfg), null, number)
  }
  for (const name of ['', 'a,b', 'a.b', 'a:b', 'a{b}', 'a"b', 'a\rb', 'a\nb', 'a b', ' a']) {
    assert.equal(uniformTabular(Array.from({ length: 8 }, () => ({ [name]: 1 }))), null, JSON.stringify(name))
  }
  const a = compressJsonText(JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ x: i }))), cfg)
  const b = compressJsonText(JSON.stringify({ items: Array.from({ length: 8 }, (_, i) => ({ x: i })) }), cfg)
  assert.notEqual(a.text, b.text, 'root array and root object must remain distinguishable')
})
