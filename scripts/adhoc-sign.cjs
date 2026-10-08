// afterPack hook: ad-hoc sign the macOS app before the dmg/zip are built.
//
// Apple silicon refuses to run code with no signature at all, and a bundle
// whose Info.plist electron-builder edited has a BROKEN signature — the
// "ASIT is damaged and can't be opened" dialog. electron-builder 25 has no
// ad-hoc mode (identity '-' is looked up in the keychain and skipped), so sign
// here. Without a paid Developer ID there is no notarization: Gatekeeper still
// asks once (right-click → Open), but the app is no longer "damaged".
const { execFileSync } = require('child_process')
const { join } = require('path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed ${app}`)
}
