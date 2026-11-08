# The 6 AM usage run

Each machine reads the tools it is signed in to and posts what it finds to the
server. The last step of each run asks the server to propose the day's model
slate (`POST /api/model-slate/propose`). Nothing is kept on the machine between
runs: a failed run is run again and sends everything again.

```
atelier runner --usage --as claude-code/MODEL
```

`ATELIER_SERVER` and `ATELIER_TOKEN` name the server and the token the run uses.
`--dry-run` reads and prints but posts nothing and asks for no slate. If the
server is unreachable or answers with anything but 2xx, the run prints what it
read, names the server and exits 1.

## What each reader gives

| Tool | Source | Windows |
| --- | --- | --- |
| zai | Z.ai's quota call, with the key in `ZAI_API_KEY` (never printed or posted) | 5-hour and weekly |
| claude-code | `~/.config/atelier/claude-usage.txt` (or `$ATELIER_CONFIG_DIR/claude-usage.txt`) | 5-hour (when the file has it) and weekly |
| antigravity | the agy CLI's `~/.gemini/antigravity-cli/cli.log`: a `RESOURCE_EXHAUSTED` line's "Resets in 4h26m8s" | `limit` at 100%, only while that line is under 26 hours old |

Each reader is a file in `cli/usage-readers/`. A reader that throws, or runs
past 20 seconds, posts its tool with no windows and a note naming it; the other
tools still post, and the run ends within 60 seconds. A tool with nothing
recent to read posts no windows and the note "usage unknown", never zero.

## Claude's figures

The Claude app reports no 5-hour window today, and nothing on disk holds the
figures. The orchestrating session reads the app's usage tool and records what
it shows:

```
atelier runner --usage --claude-capture 'FIVE WEEK FIVE_RESET WEEK_RESET'
```

FIVE and WEEK are percents used, 0 to 100. The resets are times such as
`2026-11-12T09:00:00Z`. While the app shows no 5-hour window, write `-` for both
FIVE and FIVE_RESET; the file then gives only the weekly window. A refused
capture (a bad number, the wrong count of fields, a dash for one of the
pair) exits 1 and leaves the old file. A good one is written to a temp file
and renamed, so a run never reads half of it. A capture older than 26 hours is
not used.

## Schedules

The Studio runs at 6:00, 6:20 and 6:40 ET, so that a run missed or refused at
6:00 is tried again. Install as `~/Library/LaunchAgents/net.pavi.atelier-usage.plist`
(`launchctl bootstrap gui/$(id -u) PATH`). The machine's clock is Eastern time.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>net.pavi.atelier-usage</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/atelier</string>
    <string>runner</string>
    <string>--usage</string>
    <string>--as</string>
    <string>claude-code/MODEL</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ATELIER_SERVER</key><string>https://SERVER</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>20</integer></dict>
    <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>40</integer></dict>
  </array>
</dict>
</plist>
```

Set the token and `ZAI_API_KEY` where the runner's other secrets are kept, not
in the plist.

The MacBook has its own plist, with a single `StartCalendarInterval` entry
for the MacBook's 6:00 run. It reads the tools signed in there, and its run
also ends by asking for the proposal.
