# OVOA iPhone demo for the website

The "Running late" conversation as a drop-in React component: an iPhone with a
live Dynamic Island, the iMessage thread, the voice-over, and a single sound
button under the phone. It uses the timing tuned in
`backend/public/imessage.html`.

It only needs React. No Tailwind or other packages, and its CSS is scoped
under `.ovp-`, so it won't clash with the site's styles.

## What to upload

Everything in `upload/` (also zipped as `ovoa-iphone-demo.zip`) goes into the
Lovable project at the same paths:

```
src/components/OvoaIphoneDemo.tsx
public/audio/rachel1.mp3
public/audio/rachel2.mp3
public/audio/rachel3.mp3
public/audio/ovoa1.mp3
public/audio/ovoa2.mp3
public/audio/ovoa3.mp3
```

- **Project synced to GitHub:** commit the `upload/` contents to the repo root
  and Lovable picks them up.
- **Otherwise:** attach the six mp3s to a Lovable chat message, then paste the
  prompt below followed by the contents of `OvoaIphoneDemo.tsx`.

## Prompt for Lovable

> Save the six attached mp3 files in `public/audio/` with their names unchanged.
>
> Create `src/components/OvoaIphoneDemo.tsx` with exactly the code below. Do not
> rewrite it, convert it to Tailwind, or change the timings. It is
> self-contained and only imports React.
>
> Add `<OvoaIphoneDemo maxWidth={340} />` to the hero section of the home page
> (`src/pages/Index.tsx`): beside the headline on desktop, below it on mobile.
> Keep the existing hero copy.

## Options

```tsx
<OvoaIphoneDemo
  audioBase="/audio/"   // folder holding the mp3s, with trailing slash
  maxWidth={360}        // phone scales down to fit its container, up to this
  defaultSound          // start with sound on (default true)
  showControls          // the sound button under the phone (default true)
  dark={false}          // dark iMessage theme
/>
```

## How it behaves

- **Plays when on screen.** It starts when 35% of the phone is visible, loops
  with a 4 second hold on the finished conversation, and stops when scrolled
  away.
- **Sound is on by default, within browser limits.** Browsers only play audio
  once the visitor has clicked, tapped or typed on the site:
  - **Already interacted** (for example, they arrived by clicking a link on your
    site): the voice plays straight away.
  - **Not yet interacted:** the conversation starts silently and the button
    reads "Play with sound". Their first click, tap or key press anywhere on
    the page turns the voice on, in sync with where the conversation is.
- **The button** reads "Sound on" while audible. Pressing it mutes the voice
  ("Play with sound"); pressing it again unmutes.
- **Rachel is boosted 1.5× on playback** (`VOICE_GAIN`) because her recordings
  are much quieter than OVOA's.
- **The Dynamic Island** shows "Listening" while Rachel types or speaks,
  "Working" while OVOA's typing dots show, and "OVOA" while it speaks.
- **Reduced motion.** Visitors with reduced motion enabled get the
  conversation without the animations.

## Changing the script or timing

The script and timings are the `STEPS` array at the top of the component.
Tune them in the simulator first (`cd backend && npm run demo`, then drag the
blocks on the timeline). Then copy each message's **Wait before** and
**Typing / Dots shown** values into `wait` and `dur`.

If you re-record a clip, update its `clipLen` too. This prints each length:

```bash
for f in rachel1 ovoa1 rachel2 ovoa2 rachel3 ovoa3; do ffprobe -v error -show_entries format=duration -of csv=p=0 $f.mp3; done
```
