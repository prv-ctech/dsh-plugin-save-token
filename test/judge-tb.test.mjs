import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const script = fileURLToPath(new URL('../bench/scripts/judge_tb.sh', import.meta.url))
// Source the real script; stub external tools and destructive cleanup.
const shell = `
rm() { printf 'cleanup\n'; }
mkdir() { TD="$CHECK_DIR"; }
sed() { printf '%s\n' "$*"; }
uv() { printf 'cwd=%s\nargs=%s\n' "$PWD" "$*"; return "$JUDGE_RC"; }
source "$1" "$2" "$3"
`

for (const [task, sandbox, rc, missing] of [
  ['jsonl', 'tb-jsonl-aggregator', 0], ['access', 'tb-access-logs', 0],
  ['jsonl', 'tb-jsonl-aggregator', 7], ['access', 'tb-access-logs', 7],
  ['unknown', null, 64], ['access', 'tb-access-logs', 1, true]
]) {
  test(`terminal judge: ${task}, exit ${rc}${missing ? ', missing workspace' : ''}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-token-judge-'))
    const workspace = missing ? join(dir, 'missing') : dir
    try {
      const result = spawnSync('bash', ['-c', shell, 'judge-test', script, task, workspace], {
        encoding: 'utf8', timeout: 5000,
        env: { ...process.env, CHECK_DIR: dir, JUDGE_RC: String(rc) }
      })
      assert.equal(result.status, rc, result.error?.message || result.stderr)
      assert.equal(result.stdout.match(/^cleanup$/gm)?.length, 2)
      if (sandbox) {
        assert.equal(readFileSync(join(dir, 'test_outputs.py'), 'utf8'),
          `s#WORKSPACEPLACEHOLDER#${workspace}#g ${resolve(dirname(script), '..', 'sandboxes', sandbox, 'tests/test_outputs.py')}\n`)
        assert.ok(result.stdout.includes(`TB_JUDGE_RC=${rc}\n`))
      } else {
        assert.match(result.stdout, /^unknown$/m)
        assert.doesNotMatch(result.stdout, /TB_JUDGE_RC=/)
      }
      if (sandbox && !missing) {
        assert.ok(result.stdout.includes(`cwd=${dir}\nargs=run --with pytest python -m pytest ${dir}/test_outputs.py -q\n`))
      } else assert.doesNotMatch(result.stdout, /cwd=|args=/)
    } finally {
      assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
      assert.ok(basename(dir).startsWith('save-token-judge-'))
      rmSync(dir, { recursive: true })
    }
  })
}
