// Run every smoke mode that does NOT need a logged-in Claude CLI, and fail
// loudly if any of them do.
//
// This is what CI runs on both Windows and macOS. Nobody working on this has a
// Mac to click through, so this suite is the only thing standing between "it
// compiled" and "it actually works there" — it boots the real app, opens a
// real window, drives real panes, and checks the containment invariants.
//
//   npm run smoke
const { spawn } = require('child_process')
const { join } = require('path')

// Each mode gets a timeout: a hung test must fail the run, not stall CI
// forever. (The terminal smoke spawns a real pty and has been known not to
// exit on its own once it passes.)
// Generous: a cold CI runner downloading nothing is still far slower than a
// warm dev machine, and a timeout that fires there looks identical to a real
// failure while telling you nothing.
const MODES = [
  ['ASIT_SMOKE', 300],
  ['ASIT_SMOKE_UI', 300],
  ['ASIT_SMOKE_PANES', 300],
  ['ASIT_SMOKE_SECURITY', 360],
  ['ASIT_SMOKE_TRANSFER', 300],
  ['ASIT_SMOKE_TERMINAL', 240],
  ['ASIT_SMOKE_WORKFLOWS', 300]
]

const { appendFileSync } = require('fs')
const failureDetail = []

const electron = require('electron') // resolves to the binary path string
const entry = join(__dirname, '..', 'out', 'main', 'index.js')

function run(mode, timeoutSec) {
  return new Promise((resolve) => {
    const child = spawn(electron, [entry], {
      env: { ...process.env, [mode]: '1', ASIT_NO_UPDATE: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    const collect = (b) => {
      out += b.toString()
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    let settled = false
    const finish = (ok, why) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      const lines = out
        .split(/\r?\n/)
        .filter((l) => /\[[a-z-]*smoke\]/i.test(l))
        .slice(-3)
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${mode}${why ? '  (' + why + ')' : ''}`)
      for (const l of lines) console.log(`        ${l.trim()}`)
      // On failure print the RAW tail too. CI logs need admin rights to read
      // through the API, so if this does not say what broke, nobody can find
      // out without opening a browser.
      if (!ok) {
        const tail = out.split(/\r?\n/).filter(Boolean).slice(-40)
        console.log('        ---- last output ----')
        for (const l of tail) console.log(`        ${l}`)
        failureDetail.push(`### ${mode}${why ? ` (${why})` : ''}\n\n\`\`\`\n${tail.join('\n')}\n\`\`\``)
      }
      resolve(ok)
    }

    // Passing is decided by the output, not the exit code: a mode that hangs
    // after printing ALL PASS has still done its job.
    const watch = setInterval(() => {
      if (/ALL PASS|PASS:/.test(out)) finish(true, null)
      if (/\[[a-z-]*smoke\] FAIL/i.test(out)) finish(false, 'reported FAIL')
    }, 400)

    const timer = setTimeout(() => {
      clearInterval(watch)
      finish(/ALL PASS|PASS:/.test(out), 'timed out')
    }, timeoutSec * 1000)

    child.on('exit', (code) => {
      setTimeout(() => {
        clearInterval(watch)
        finish(/ALL PASS|PASS:/.test(out), code === 0 ? null : `exit ${code}`)
      }, 250)
    })
  })
}

;(async () => {
  console.log(`smoke suite on ${process.platform} (${process.arch})\n`)
  const failed = []
  for (const [mode, timeout] of MODES) {
    const ok = await run(mode, timeout)
    if (!ok) failed.push(mode)
  }
  console.log()
  // GitHub renders this on the run page, which needs no special access —
  // unlike the logs.
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Smoke suite — ${process.platform} ${process.arch}\n\n` +
          (failed.length === 0
            ? `All ${MODES.length} modes passed.\n`
            : `**Failed: ${failed.join(', ')}**\n\n${failureDetail.join('\n\n')}\n`)
      )
    } catch {
      // a summary we cannot write is not worth failing over
    }
  }
  if (failed.length > 0) {
    console.error(`${failed.length} smoke mode(s) failed: ${failed.join(', ')}`)
    process.exit(1)
  }
  console.log(`all ${MODES.length} smoke modes passed`)
})()
