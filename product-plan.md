# Distribution, render server, and the commercial shape

**Status:** nothing here is built. Written 2026-08-10. Three tracks, in the order
they unblock each other: get the extension onto teammates' machines, get
rendering off the laptop, decide the licence before anyone else touches the
code.

## What tapeworm is for

Worth stating plainly, because the rest of this document leans on it: tapeworm
makes **choreographed recordings of real websites**. Not captures of a session,
not animations that resemble a site. The competition splits into two camps and
neither is trying to do this.

Real-time capture (Screen Studio, Rotato) records whatever the machine drew
during that take. The motion is your hand on the trackpad, once, live; camera
moves and cursor polish are added afterwards. The take is the take — jank,
dropped frames and a wobbly scroll are baked in, and a change of pacing means
recording it again.

General animation tools (After Effects, Jitter, Figma) produce a drawing of the
site. You control everything, at the cost of rebuilding the page as artwork, and
it stops being true the moment the site ships.

tapeworm films the live site one frame at a time, under direction: anchors,
easing, holds, clicks, recorded gestures. Three properties fall out of that, and
they are the product:

- **The motion is directed, not performed.** Scroll positions come from anchors
  and easing curves, so a shot can be re-timed without re-shooting. The site
  does the acting; you do the camerawork.
- **There is no jank, by construction.** Nothing is captured in real time, so
  nothing can drop a frame. Output is deterministic and identical across runs.
- **The choreography is a document.** A timeline is JSON — versionable,
  diffable, re-runnable against the site six months later, and (because frame
  _N_ never depends on frame _N−1_) splittable across as many machines as you
  point at it.

That last property is also the commercial argument. A screen recording is a
one-off artefact; a tapeworm timeline is an asset you re-run every time the site
ships.

**The invariant to protect.** Every time-dependent thing is seeked from the
frame index, never read from the wall clock. That rule is what makes `--jobs`
sharding possible, and sharding is what makes hosted rendering economically
sane: a 30-second 60fps clip is 1800 independent frames, so turnaround scales
with money spent rather than with clip length. No tool doing real-time capture
can offer that. CLAUDE.md already calls reintroducing wall-clock or
previous-frame dependence an architectural regression — it is also a product
one.

## Track 1: distribution to the team

Four routes exist. Only two auto-update, and one of those needs managed Chrome.

| Route                             | Auto-updates           | Needs                                       | Verdict                                                                                                                    |
| --------------------------------- | ---------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Load unpacked from a clone        | No — `git pull` then ⟳ | Node, and remembering `npm run sync-shared` | Keep it. The developer path, not the distribution path.                                                                    |
| Zip → unzip → load unpacked       | No                     | Nothing                                     | Strictly worse than the clone for anyone who has Node. Only wins for someone who doesn't.                                  |
| Self-hosted `.crx` + `update_url` | Yes                    | Managed Chrome, MDM or Workspace policy     | Chrome blocks off-store CRX installs on unmanaged profiles. Viable only if the team's browsers are already policy-managed. |
| **Chrome Web Store, unlisted**    | **Yes**                | $5 one-off, a listing, review turnaround    | **Do this.** Installable by link, not searchable.                                                                          |

An unlisted store item is the only route that gets real auto-updates without
touching device policy, and it front-loads the review process onto a low-stakes
internal release rather than onto launch day. If everyone is on a Workspace
domain, the store's _private_ visibility narrows it to the org.

### Two things that will surprise people

**The extension ID changes.** The pinned `key` has to come out of the manifest
before upload — the store assigns its own and rejects a mismatched one, as
`extension/README.md` already notes. A different ID means a different
`chrome.storage.local` bucket, so the saved-timelines library and the per-site
autosaves do not carry across from a dev install. That is the right outcome (dev
and prod stop stomping each other), but it belongs in the rollout note rather
than being discovered.

**The store build must never be hand-assembled.** Byte-identical `shared/`
copies are enforced by `npm test`; the packaging step is not. Add one.

### Sequence

1. Add `npm run pack:extension`: run `sync-shared`, copy `extension/` to a temp
   dir, strip the `key` field, verify the version, zip. No dependencies — the
   same shape as `scripts/sync-shared.mjs`.
2. Register the developer account, pay the $5, create the item as **unlisted**.
   Screenshots and a description are required; `extension/README.md` has the
   copy.
3. Set a version policy. The extension and CLI currently share `0.1.0`, and the
   store requires a monotonic version per upload — so decide whether they stay
   locked or diverge. Locked is simpler while the config format is still moving,
   at the cost of a store upload per CLI patch.
4. Send the install link with two lines: what changed, and that existing
   dev-install saves stay in the dev install.
5. Keep the clone-and-load instructions in `extension/README.md`.

**Open question:** are the team's browsers managed by Workspace or MDM? If so,
the self-hosted CRX route becomes viable and store review can be skipped
entirely. This changes the whole track.

## Track 2: a render server on the NAS

The code is already shaped for this. The renderer has no npm dependencies and no
build step, the config is a validated JSON document, and `bin/tapeworm.ts`
already accepts a config on stdin — which is the interface a job runner wants.
The work is almost entirely environment, not architecture.

`authoring-plan.md` anticipated this as "the one future event that would justify
restructuring… and even that can be its own repo consuming exported configs."
That still holds: the server consumes configs over HTTP and shells out to the
CLI. Nothing in this repo needs to move.

### The container

Node 22 slim, plus Chromium and ffmpeg as system packages. Chrome inside Docker
needs `--shm-size=1g` (or `--disable-dev-shm-usage`) and a sandbox decision.
Beyond that, two environment differences change what comes out of the file, and
neither announces itself.

**Fonts are the one that silently ruins renders.** A bare Linux container ships
none. Sites that load webfonts are fine; anything falling through to a system
stack renders in a substitute or as tofu. The render succeeds, the progress bar
fills, and the video is wrong. Bake in fontconfig and a real font set, and
document how to add a client's licensed fonts to the image.

**Speed is the other.** No GPU means Chrome falls back to software
rasterisation — slower than a Mac by a wide margin, and subtly different on
WebGL and heavy canvas work. Design it as a batch queue people submit to and
walk away from, not something they watch. On the upside, `--jobs` saturates
whatever cores the box has with no new code.

Verify the image by rendering a known config inside it and diffing the output
against a local render of the same config. Determinism makes that a real test,
not a vibe check.

### The API

Small enough to write in a day using only `node:http`:

```
POST   /v1/renders            { config }        -> { id }
GET    /v1/renders/:id        -> { state, frame, total, startedAt }
GET    /v1/renders/:id/video  -> the mp4
GET    /v1/renders/:id/log    -> renderer stderr, for the failures
DELETE /v1/renders/:id        cancel, or reap the output
```

Serial queue, one or two concurrent jobs, outputs on a mounted volume with a
retention sweep. A single HTML page with a textarea, a Submit button and a
progress line is the whole client for version one — that is the copy-and-paste
step.

### Two gaps the server exposes that don't matter locally

- **No auth injection.** The config schema (`src/types.ts`) has no way to set
  cookies or request headers, so anything behind a login or basic auth cannot be
  filmed from a machine that isn't yours. Adding `page.headers` and
  `page.cookies` is a small, well-scoped change to `types.ts`, `config.ts` and
  `page.ts` — and it is needed for staging sites, which is most of what a team
  would want to film.
- **`page.substitute` points at the wrong disk.** Local replacement files
  resolve on the renderer's filesystem, which is now the NAS. Fixing it properly
  means uploading a bundle — config plus assets — rather than a bare JSON body.
  Defer the implementation, but shape the endpoint so a multipart body can be
  added later without a version bump.

### The step that actually changes how it feels

Once the API exists, the panel grows a **Render on server** button: POST the
config, poll the job, offer the file when it lands. That is a `host_permissions`
entry for the server origin and some fetch code — and it removes the terminal
from the workflow entirely, which is the difference between a tool you can use
and a tool the rest of the team can use.

Treat the paste-a-JSON page as scaffolding. It exists to prove the client/server
split works; the button is the deliverable.

### Sequence

1. Dockerfile with Chromium, ffmpeg and fonts; verify by diffing a container
   render against a local one.
2. Job server and queue over `node:http`, outputs to a volume, plus the
   paste-a-config page.
3. Add `page.headers` and `page.cookies` to the config schema so staging sites
   work.
4. **Render on server** in the panel, pointed at the NAS. The team becomes the
   design partner for the hosted product.

**Open question:** what is actually in the NAS? Core count and RAM decide
whether `--jobs` helps or thrashes, and whether this is a two-minute wait or a
twenty-minute one. Worth measuring before building the queue.

## Track 3: the commercial shape

Open core with a paid hosted service fits: the renderer is the thing people can
run themselves, and the annoying parts — a warm Chrome, correct fonts, parallel
workers, somewhere to put a 30MB file — are what a service is for. Three things
are worth deciding deliberately rather than by default.

### Licensing — decide before the first outside pull request

The repo is MIT, which means anyone can host the renderer in competition with
tapeworm.studio. The usual split keeps the CLI and renderer permissive — that is
the part you want people compiling and running themselves — while the server and
orchestration layer go AGPL or source-available. This gets substantially harder
once outside contributors exist: changing it later needs a CLA or every
contributor's agreement. Cheapest decision on this page today, most expensive
one in a year.

Recommendation: MIT renderer, restrictive server.

### Economics

The unit of cost is CPU-seconds of Chrome, and it is bursty. Credits or
render-minutes map onto that honestly. Long renders sit awkwardly on serverless
timeouts, but shards do not — each is a short, independent job, which is a good
fit for ephemeral workers and is why the frame-index invariant is a business
asset rather than just a nice property.

Billing runs through Stripe on tapeworm.studio, with the extension
authenticating against the account system. The Chrome Web Store has not handled
payments since 2020, so external payment is the expected arrangement, not a
workaround.

### Two risks worth an answer before launch

- **A hosted browser that fetches arbitrary URLs is an attack surface.** Egress
  allowlisting, blocked private IP ranges and blocked cloud metadata endpoints
  need to exist from the first public render, not be added after someone points
  it out.
- **Filming other people's sites at scale invites questions** about terms of
  service and copyright. A short acceptable-use policy costs nothing now and is
  awkward to retrofit.

### Who buys it

Studios and agencies producing case-study films, launch reels and portfolio
pieces. The pitch comes straight from the premise: the site, filmed properly, at
any resolution, as many times as the design changes. The recurring-revenue
argument is that last clause.

### Sequencing

1. Unlisted store item — the team installs properly.
2. NAS server and the paste-a-config page — the client/server split is proven.
3. **Render on server** in the panel — the terminal leaves the workflow.
4. The same server, hosted, behind accounts — the new parts are auth, storage
   and limits.
5. Billing.

Register tapeworm.studio now regardless of when steps four and five happen. It
is the cheapest option value here.

## Decisions outstanding

| Question                                                   | Why it matters                                                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Is the team's Chrome managed by Workspace or MDM?          | If yes, a self-hosted CRX works and store review is unnecessary. Changes Track 1 entirely.                                                                   |
| Does the extension version stay locked to the CLI version? | Locked is simpler while the config format moves, but costs a store upload per CLI patch. Recommend locked for now.                                           |
| Does the renderer stay MIT?                                | MIT is a real commitment to the compile-it-yourself promise, and a real invitation to be hosted by someone else. Recommend MIT renderer, restrictive server. |
| What hardware is in the NAS?                               | Sets whether `--jobs` helps, and whether this is a two-minute or twenty-minute wait.                                                                         |
