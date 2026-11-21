/** Verifies the service definitions the background server installs on macOS and Linux. */
import assert from "node:assert/strict"
import test from "node:test"

import {
  launchAgentPlist,
  parseSystemdProperties,
  systemdUnit,
} from "../electron/background-server.mjs"

const options = {
  home: "/home/sam/.blitz",
  nodePath: "/home/sam/.nvm/versions/node/v24.0.0/bin/node",
  environment: { PATH: "/usr/local/bin:/usr/bin", BLITZ_PORT: "3007" },
}

test("the launchd agent runs the current release and keeps it alive", () => {
  const plist = launchAgentPlist(options)
  assert.match(plist, /<string>dev\.blitz\.server<\/string>/)
  assert.match(plist, /<string>\/home\/sam\/\.blitz\/current\/scripts\/dev-lan\.mjs<\/string>\s*<string>--service<\/string>/)
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/)
})

test("the systemd unit runs the current release, restarts forever and starts at login", () => {
  const unit = systemdUnit(options)
  assert.match(
    unit,
    /^ExecStart="\/home\/sam\/\.nvm\/versions\/node\/v24\.0\.0\/bin\/node" "\/home\/sam\/\.blitz\/current\/scripts\/dev-lan\.mjs" "--service"$/m
  )
  assert.match(unit, /^WorkingDirectory=\/home\/sam\/\.blitz$/m)
  assert.match(unit, /^Environment="PATH=\/usr\/local\/bin:\/usr\/bin"$/m)
  assert.match(unit, /^Environment="BLITZ_PORT=3007"$/m)
  assert.match(unit, /^Restart=always$/m)
  assert.match(unit, /^StartLimitIntervalSec=0$/m)
  assert.match(unit, /^StandardOutput=append:\/home\/sam\/\.blitz\/logs\/server\.log$/m)
  assert.match(unit, /^WantedBy=default\.target$/m)
})

test("the systemd unit escapes quotes, specifiers and variables", () => {
  const unit = systemdUnit({
    home: "/home/sam/100%/blitz",
    nodePath: '/opt/my "node"/$HOME/node',
    environment: { PATH: 'C:\\odd "path"%' },
  })
  assert.match(unit, /^ExecStart="\/opt\/my \\"node\\"\/\$\$HOME\/node" "\/home\/sam\/100%%\/blitz\/current/m)
  assert.match(unit, /^WorkingDirectory=\/home\/sam\/100%%\/blitz$/m)
  assert.ok(unit.includes('Environment="PATH=C:\\\\odd \\"path\\"%%"'))
  assert.throws(() =>
    systemdUnit({ ...options, environment: { PATH: "a\nb" } })
  )
})

test("systemctl show output is read into properties", () => {
  assert.deepEqual(parseSystemdProperties("ActiveState=active\nMainPID=4242\n"), {
    ActiveState: "active",
    MainPID: "4242",
  })
})
