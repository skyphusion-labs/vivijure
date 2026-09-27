# Make your first film

The path from an idea to something you can watch, in the order you actually do it. This page is
about the *filmmaking*, not the install: it assumes you already have a studio open, whether that
is the hosted one or your own.

> **Before you start, read [What Vivijure can do today](CAPABILITIES.md).** Two steps near the
> end are not finished, and one of them is the one that joins your clips into a single film. This
> page tells you where you will stop and what you get when you do. It is better to know that now
> than at shot ten.

Nothing on this page names a provider. Which model or GPU serves each step is a detail that
changes, and it lives in one column of the matrix so it can change in one place.

---

## 1. Say what the film is

You write a short brief; the studio turns it into a **storyboard**: an ordered list of shots,
each with a description and, if anyone speaks, a line of dialogue.

This is the step where you are actually directing, and it is the cheapest one to redo. A
storyboard costs a little text generation. Every later step costs GPU seconds. Read the shot list
and fix it here, not after you have paid to animate it.

You can also write it in Discord and hand it over, or drive the whole thing from an AI agent.

## 2. Decide who is in it

If the same character appears in more than one shot, cast them. Casting fixes what a character
looks like so shot seven is recognisably the same person as shot one.

Skip it for a film with no recurring characters. Do not skip it for anything with a person in it
that you care about, because consistency is the hardest thing to fix later.

## 3. Draw the stills

Before any motion, the studio makes **one still per shot**: the keyframe. This is the single most
useful checkpoint in the whole process.

Look at them. A bad keyframe becomes an expensive bad clip, and a keyframe is cheap by
comparison. Regenerate the ones that are wrong, adjust the shot description, and only move on
when the stills look like the film you meant.

## 4. Put them in motion

Each still becomes a short moving clip. This is the slow, expensive part: it is real GPU work,
and it is where most of your time and money goes.

You choose which door does it, and the honest summary is that they differ in cost, speed, clip
length and whether the result can talk. The matrix lists what is installed on your studio.

## 5. Let them speak, if they speak

Two separate things, and people conflate them:

- **The voice** is generated audio for a character's line.
- **The mouth** is the character's lips matching that audio.

The mouth is done **at the same time as the motion**, by a door that takes the voice as input.
It is not a later touch-up applied to a finished clip. That matters when you pick a door in step
4: some can speak and some cannot, and picking a silent one means going back.

## 6. Score it

Music, narration, and cuts timed to the beat. You do this after the picture, because scoring
something you are still re-cutting is wasted work.

Generating a bed works. **Attaching it to a finished film is part of the unfinished step below**,
so today you can produce the audio and not yet marry it to the picture.

## 7. Polish each clip

Smoother motion, a sharper picture, a colour grade. Per shot, optional, and off by default except
where a module says otherwise. Check the matrix before relying on these: there is an open defect
against the endpoints behind them.

## 8. Join the clips into a film

**This does not work yet, and this page is not going to pretend otherwise.**

The code that concatenates your clips, crossfades them, muxes the audio and burns in titles and
subtitles is real and it works. The machines it ran on were decommissioned on 2026-09-24 and have
not been replaced. A studio that has not been pointed at a finishing tier will tell you so and
hand you **your individual clips**, which are complete, rendered and yours.

So the honest end of the path today is: a folder of finished shots, not a single `film.mp4`. You
can join them in any editor in the meantime. The replacement is being built; the matrix links the
work.

## 9. Take it with you

Download what you made. Every artifact is yours, on storage you control, in ordinary formats. No
part of this requires you to keep an account open to keep your films.

---

## What to expect the first time

- **The stills stage is where you direct.** Most people's first film goes wrong because they
  approved keyframes they had not really looked at.
- **Motion is the money.** Everything before it is cheap; nothing after it is as slow.
- **Decide about talking before step 4**, not after.
- **You will finish with clips, not a film,** until the finishing tier returns. Plan around it.

## When something goes wrong

A render that fails should tell you which shot failed and why, rather than quietly handing you
something shorter than you asked for. If you get a completed render with fewer shots than your
storyboard, that is a bug worth reporting, not a thing you did wrong.

If a step in the matrix is marked `CAVEATS` or `NOT YET`, check the linked issue before assuming
the fault is yours.
