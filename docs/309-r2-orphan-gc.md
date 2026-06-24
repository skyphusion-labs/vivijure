# #309 -- R2 cast-orphan GC: reconciler + dry-run record

Follow-up to #298. Sweeps the pre-#298 backlog of cast-delete-orphaned R2
artifacts (every cast deletion before #298 leaked its portrait/refs/sources/
LoRA). See `scripts/r2-orphan-gc.ts` (IO) + `src/r2-orphan-reconcile.ts` (pure,
tested core).

## Safety model (verify by ID / by reference, never by slug)
A key is an orphan ONLY when no live owner is found, decided against the live
`cast_members` id set and the keys / LoRA dirs any live cast row OR any render
references. The #298 near-miss is the reason: a broad "wren" grep flagged
`loras/lora-wren-1782248711/` for deletion, but that LoRA is LIVE (cast id 4) --
only a verify-by-id check spared it. Anything not provably cast-owned (films,
load tests, smokes) is left out-of-scope, never deleted.

Multi-run nuance: ownership is decided PER DIR, not per slug. An OLD training run
of a live cast is an orphan if that exact dir is unreferenced -- e.g.
`loras/lora-companion-robot-1782198520/` is swept (live cast 6 uses
`-1782245014`), and `loras/wren_talks_test_2/` is swept (unreferenced; not the
artifact any live cast uses). Decision per Conrad: "if we didn't keep it, it's
not meant to be" -- only the referenced run survives.

## How to run
```
# dry run (default; lists keys + counts + bytes, deletes nothing):
node scripts/r2-orphan-gc.ts --owners docs/309-r2-orphan-gc-owners.json
# apply (irreversible; ONLY after a human eyeballs the dry-run):
node scripts/r2-orphan-gc.ts --owners docs/309-r2-orphan-gc-owners.json --apply
```
R2 access via an rclone remote (`R2_REMOTE`/`R2_BUCKET`, default `r2:vivijure`).
The owner snapshot (`--owners`) is `{ castRows, renderLoraDirs, seedPrefixes }`,
built from a D1 query of `cast_members` plus a `renders` LoRA-reference scan. The
snapshot used here is committed as `309-r2-orphan-gc-owners.json` (point-in-time
2026-06-24; do NOT reuse for a later GC -- re-query D1).

## Dry-run record (2026-06-24, live R2 + live D1 snapshot)
Live casts: ids 2,4,5,6,13..20. Every candidate confirmed 0 references in
`cast_members` (by id) AND the `renders` JSON columns.

```
scanned 459 objects: 152 orphan, 221 kept, 86 out-of-scope

out-of-scope LoRA dirs left intact (not cast-scheme): 45
  . loras/EMBER/
  . loras/Echo/
  . loras/Packet_Chase/
  . loras/RUST/
  . loras/aspect-verify/
  . loras/bake-vfree-test/
  . loras/cl_owngpu_0623/
  . loras/finaltier-00/
  . loras/fur_and_circuits/
  . loras/loadtest-00/
  . loras/loadtest-01/
  . loras/loadtest-02/
  . loras/loadtest-03/
  . loras/loadtest-04/
  . loras/loadtest-05/
  . loras/loadtest-06/
  . loras/loadtest-07/
  . loras/loadtest-1/
  . loras/loadtest-2/
  . loras/loadtest-3/
  . loras/loadtest-4/
  . loras/neon-av-verify/
  . loras/neon-finish-verify/
  . loras/neon-halflife-v001/
  . loras/neon-smoke-v015/
  . loras/neon_halflife/
  . loras/pose-v3-smoke/
  . loras/reshowcase-fur-01/
  . loras/reshowcase-rust-01/
  . loras/rollins-400-test/
  . loras/rust-loadtest-confirm/
  . loras/rust-lt-00/
  . loras/rust-lt-01/
  . loras/rust-lt-02/
  . loras/rust-lt-03/
  . loras/rust-lt-04/
  . loras/rust-lt-05/
  . loras/rust-lt-06/
  . loras/rust-lt-07/
  . loras/stdtier-v027-00/
  . loras/talking_lipsync/
  . loras/talking_lipsync_verify/
  . loras/the_horizon_line/
  . loras/v0212-00/
  . loras/v0213-verify-00/

ORPHANS (152 objects, 2.0 GiB):
  [cast id 10 has no live cast_members row] -- 11 obj, 5.6 MiB
    DELETE cast/10/portrait.jpg  (533.6 KiB)
    DELETE cast/10/refs/0571be3b-215a-4398-b588-9358e4e4a939.jpg  (422.0 KiB)
    DELETE cast/10/refs/19ae1927-c009-40ea-a3da-01c1ce13e6be.jpg  (581.5 KiB)
    DELETE cast/10/refs/1cc8173d-5d72-480a-afc2-86a3fdc8d6a3.jpg  (547.6 KiB)
    DELETE cast/10/refs/1ea65b0b-7501-4776-9067-4a6f891797f6.jpg  (563.9 KiB)
    DELETE cast/10/refs/2449a0b4-f36f-4004-9f20-396ea6c8f23e.jpg  (549.8 KiB)
    DELETE cast/10/refs/281bdad1-bb2e-4317-826f-b8a2ba89e299.jpg  (626.3 KiB)
    DELETE cast/10/refs/4ea81310-6432-42ba-8c65-0409ea1bbb99.jpg  (439.5 KiB)
    DELETE cast/10/refs/6e860a51-7e83-4c2c-8d13-5b91cfe712c0.jpg  (530.2 KiB)
    DELETE cast/10/refs/ce66be82-4f90-45ee-8a17-e94ca84940e0.jpg  (506.0 KiB)
    DELETE cast/10/refs/e655a6c3-2d7a-4d0a-8f26-95f71ba54a8e.jpg  (443.5 KiB)
  [cast id 3 has no live cast_members row] -- 44 obj, 25.9 MiB
    DELETE cast/3/portrait.jpg  (640.5 KiB)
    DELETE cast/3/refs/0ab30a19-3fe8-4230-bb93-26ceae790392.png  (582.0 KiB)
    DELETE cast/3/refs/0c1378e2-08a2-41cf-87d3-63a23ec85988.png  (786.8 KiB)
    DELETE cast/3/refs/116394b8-f55f-44d8-9724-8bdc8172b689.png  (683.8 KiB)
    DELETE cast/3/refs/16674416-9ad4-4276-be81-22f84b3ece7d.png  (622.7 KiB)
    DELETE cast/3/refs/237c1287-d8a8-4cde-b1eb-33fe24b729b2.png  (667.8 KiB)
    DELETE cast/3/refs/2c9c7ee4-e4d6-408e-b8fd-5254f9f2e890.png  (560.8 KiB)
    DELETE cast/3/refs/2fe00e52-693f-4293-8454-c292798ad617.png  (512.2 KiB)
    DELETE cast/3/refs/30494ac5-9a0a-4635-8d50-ac9bedbfef08.png  (681.7 KiB)
    DELETE cast/3/refs/30c01a0a-58fa-42cf-b7f9-e7f0cf1f6d6b.png  (585.9 KiB)
    DELETE cast/3/refs/35ff76a0-93e7-4560-819b-63f7ce404830.png  (375.3 KiB)
    DELETE cast/3/refs/3c483bb2-3801-4167-9782-0be30c5f9857.png  (708.1 KiB)
    DELETE cast/3/refs/3d90414c-5e94-44c8-90a2-ee71df0ca152.png  (658.3 KiB)
    DELETE cast/3/refs/3ef2014c-b8ad-4b78-b0de-d567da854b5f.png  (502.1 KiB)
    DELETE cast/3/refs/3f08d8f4-0c6c-42bf-a587-89cfdb21fc08.png  (794.0 KiB)
    DELETE cast/3/refs/4eb1d426-316a-448d-9d79-ee8e8c13e2ea.png  (672.8 KiB)
    DELETE cast/3/refs/501babee-73bd-4173-897e-e990f0b4055b.png  (678.3 KiB)
    DELETE cast/3/refs/66cdd119-8bd2-4d2c-b927-591433d6303d.png  (714.9 KiB)
    DELETE cast/3/refs/6887d8f1-496a-4577-b680-f7f52165a05b.png  (725.4 KiB)
    DELETE cast/3/refs/6911996f-1fa3-4f8e-961e-2f6be2e0ca03.png  (536.8 KiB)
    DELETE cast/3/refs/6dd5abac-5cee-4c20-8b8e-398ff34a4484.png  (464.3 KiB)
    DELETE cast/3/refs/745672cd-5062-44d0-ba25-81a657c39fb6.png  (504.1 KiB)
    DELETE cast/3/refs/798e3612-a7f5-40a1-8e34-fb8da3a59695.png  (693.4 KiB)
    DELETE cast/3/refs/869b1110-4c41-47ec-95de-b315a450bc6f.png  (525.3 KiB)
    DELETE cast/3/refs/876d6cc0-ee96-4a8d-a09c-e0c9263f1d82.png  (542.9 KiB)
    DELETE cast/3/refs/8d37fb8b-c7d0-425c-8d6b-c2248c749394.png  (546.4 KiB)
    DELETE cast/3/refs/a30be553-892f-4032-993f-6de39ad67736.png  (569.4 KiB)
    DELETE cast/3/refs/a538ea1d-07d3-435f-9ab4-4d5401dae81c.png  (497.6 KiB)
    DELETE cast/3/refs/a9d85f63-a840-46db-9e4b-7a944210b884.png  (618.3 KiB)
    DELETE cast/3/refs/af29dc37-3fa3-4ebc-bc2f-9267810c3ca3.png  (504.2 KiB)
    DELETE cast/3/refs/af7171f3-77b1-425e-9789-5bbef455ed94.png  (834.6 KiB)
    DELETE cast/3/refs/b20c8fbf-62b4-4504-a1af-af6cbf5ce1a3.png  (508.5 KiB)
    DELETE cast/3/refs/bb86da2d-01eb-4f10-9a64-6963d7c95593.png  (547.5 KiB)
    DELETE cast/3/refs/be25ffed-4b64-43cb-93cb-a6484031621e.png  (909.5 KiB)
    DELETE cast/3/refs/c6f19d6b-7b56-45eb-b060-8ce8e3401c83.png  (497.8 KiB)
    DELETE cast/3/refs/d2f75162-39ed-49ac-af61-af289d05e464.png  (461.8 KiB)
    DELETE cast/3/refs/d31098f1-a388-460f-b914-8e6aa7ddc021.png  (733.6 KiB)
    DELETE cast/3/refs/d4544850-afa8-4e95-b77f-84f8b05e9b68.png  (536.8 KiB)
    DELETE cast/3/refs/d7cf505d-598c-43c2-a797-29621b52c2db.png  (492.7 KiB)
    DELETE cast/3/refs/d8506b53-9997-45db-ba57-ff4ded887520.png  (446.8 KiB)
    DELETE cast/3/refs/dd72373e-8402-4962-a4f5-27c0897ad2cf.png  (408.6 KiB)
    DELETE cast/3/refs/dda40eec-e302-4c5e-bbfc-0680d48770d2.png  (697.3 KiB)
    DELETE cast/3/refs/e9959e0c-0b9c-4e26-a265-cc83b8f3b5fc.png  (556.0 KiB)
    DELETE cast/3/refs/f3fa56c4-b689-4ba6-9a30-41adf8511be3.png  (754.5 KiB)
  [cast id 7 has no live cast_members row] -- 33 obj, 16.9 MiB
    DELETE cast-gen/7/0ba995f7-6225-488b-9161-31cbb7740702.state.json  (721 B)
    DELETE cast-gen/7/b55b3250-d745-46a8-a0d7-2f3a7e066876.state.json  (732 B)
    DELETE cast-gen/7/ref_01.jpg  (669.9 KiB)
    DELETE cast-gen/7/ref_01.png  (567.3 KiB)
    DELETE cast-gen/7/ref_02.jpg  (677.4 KiB)
    DELETE cast-gen/7/ref_02.png  (699.1 KiB)
    DELETE cast-gen/7/ref_03.jpg  (519.2 KiB)
    DELETE cast-gen/7/ref_03.png  (396.5 KiB)
    DELETE cast-gen/7/ref_04.jpg  (654.5 KiB)
    DELETE cast-gen/7/ref_04.png  (639.1 KiB)
    DELETE cast-gen/7/refs-65e635ba-c9bc-4dac-9200-b37682acbb82.refs-job.json  (590 B)
    DELETE cast-gen/7/refs-dab21bd3-906b-485d-99a5-be8575aad4eb.refs-job.json  (579 B)
    DELETE cast/7/portrait.jpg  (902.0 KiB)
    DELETE cast/7/refs/015f49f4-13e5-4a4b-8982-314fdd7a7632.jpg  (637.9 KiB)
    DELETE cast/7/refs/0ed84e34-60a9-4ed6-984f-bc71b6c57149.png  (1.1 MiB)
    DELETE cast/7/refs/32f5aa9c-7782-4d81-aa2b-89b209b998e4.jpg  (545.5 KiB)
    DELETE cast/7/refs/3d9ecebb-087d-471e-9a5d-c7b569167224.jpg  (541.7 KiB)
    DELETE cast/7/refs/4426913f-aa51-42c8-9bf4-c9a583fce181.jpg  (504.9 KiB)
    DELETE cast/7/refs/4bec7305-a4fe-4eed-88ec-979f193e2d41.jpg  (636.7 KiB)
    DELETE cast/7/refs/5312807f-95ae-4ccd-b273-9e6eac6e1730.jpg  (439.8 KiB)
    DELETE cast/7/refs/5534c8bd-072a-4c7c-bb1d-fc47e53433cc.jpg  (585.9 KiB)
    DELETE cast/7/refs/770abe4e-1b09-4a08-8db8-2d68cf672c6b.jpg  (645.4 KiB)
    DELETE cast/7/refs/78c7abf7-3d37-4708-8078-c7dd55bb3072.jpg  (567.6 KiB)
    DELETE cast/7/refs/9d1a3145-b06d-479b-8a07-bb1bb5743c40.jpg  (647.2 KiB)
    DELETE cast/7/refs/aa0512bc-7b29-4041-afba-89a769db0a2f.jpg  (590.9 KiB)
    DELETE cast/7/refs/ab8d0dd7-e849-4a1b-9247-21734b2a2014.jpg  (494.7 KiB)
    DELETE cast/7/refs/afa961d6-5ac5-40f0-85d4-36313fbc1dc6.jpg  (498.2 KiB)
    DELETE cast/7/refs/b2e57021-5c13-49f4-accb-38bc02bdc0aa.jpg  (576.0 KiB)
    DELETE cast/7/refs/b47be9bc-ceb5-49a5-bb66-50c5ecf7e2d4.jpg  (447.4 KiB)
    DELETE cast/7/refs/d433ae39-5029-4311-8e3c-174763786840.jpg  (535.2 KiB)
    DELETE cast/7/refs/e18da4ee-2e0f-4977-929d-dc5800819042.jpg  (503.5 KiB)
    DELETE cast/7/refs/e75cbaba-8d42-461a-bae4-9601c256b266.jpg  (491.5 KiB)
    DELETE cast/7/refs/fff287cf-8ec3-42cd-a7f0-e56ab7e5bd48.jpg  (584.9 KiB)
  [cast id 8 has no live cast_members row] -- 20 obj, 13.2 MiB
    DELETE cast/8/portrait.jpg  (620.1 KiB)
    DELETE cast/8/refs/0b10b2a6-bc7a-483b-a3c7-8b22580eb35c.jpg  (525.9 KiB)
    DELETE cast/8/refs/19290d66-f032-4a7a-8641-96e213147c1f.jpg  (414.2 KiB)
    DELETE cast/8/refs/1b93caa6-259a-43ae-a445-5a4758443cdc.jpg  (436.1 KiB)
    DELETE cast/8/refs/215396c4-637a-42cd-86c9-bfae3d6c6839.jpg  (589.4 KiB)
    DELETE cast/8/refs/336232fe-66cf-4036-a7bf-ac3e5e8210dc.jpg  (572.4 KiB)
    DELETE cast/8/refs/33f2dcf9-daa8-44e7-929f-57e2756384aa.jpg  (508.6 KiB)
    DELETE cast/8/refs/4ebea9ce-c62f-4b85-8c3f-bfcda8248c1b.jpg  (493.0 KiB)
    DELETE cast/8/refs/5af03e0b-df21-4b4c-969d-de97a10a1458.png  (1.3 MiB)
    DELETE cast/8/refs/5efc0f52-01b9-4616-a435-1d13d3097499.png  (1.3 MiB)
    DELETE cast/8/refs/6e088d08-3e59-4383-9a16-9623d16d31c4.jpg  (458.3 KiB)
    DELETE cast/8/refs/774f7a67-48bd-40b7-a73d-433c357f55dc.jpg  (518.6 KiB)
    DELETE cast/8/refs/9ebab466-e1c0-4730-a09a-cd9050b1ff75.jpg  (581.1 KiB)
    DELETE cast/8/refs/a8c85855-ac3f-419f-bc8e-ec3049632dca.jpg  (462.1 KiB)
    DELETE cast/8/refs/acddd267-de66-4724-b911-a9aaf1423ef0.jpg  (530.8 KiB)
    DELETE cast/8/refs/c002efd3-ed9b-4549-afe1-a5029535cd70.jpg  (613.1 KiB)
    DELETE cast/8/refs/cf10b410-8451-4cac-8394-e584555b2470.png  (1.2 MiB)
    DELETE cast/8/refs/e012ad64-62dc-4541-ab1d-c6e621f51cf7.jpg  (572.8 KiB)
    DELETE cast/8/refs/ea86a836-87f1-4459-bbc5-fda24dd11797.jpg  (564.7 KiB)
    DELETE cast/8/refs/f8751189-5bfc-4523-bf2b-254af59672d9.png  (1.2 MiB)
  [cast id 9 has no live cast_members row] -- 14 obj, 6.3 MiB
    DELETE cast-gen/9/8e82568f-94af-4c25-b66c-ff88e84fa194.state.json  (707 B)
    DELETE cast-gen/9/a4de3544-8eb7-42b4-a86a-dec17ae9e152.state.json  (1020 B)
    DELETE cast-gen/9/ref_01.jpg  (654.7 KiB)
    DELETE cast-gen/9/ref_02.jpg  (738.3 KiB)
    DELETE cast-gen/9/ref_03.jpg  (454.1 KiB)
    DELETE cast-gen/9/ref_04.jpg  (687.1 KiB)
    DELETE cast-gen/9/ref_05.jpg  (655.5 KiB)
    DELETE cast-gen/9/ref_06.jpg  (709.0 KiB)
    DELETE cast-gen/9/ref_07.jpg  (644.9 KiB)
    DELETE cast-gen/9/ref_08.jpg  (696.1 KiB)
    DELETE cast-gen/9/ref_09.jpg  (548.3 KiB)
    DELETE cast-gen/9/ref_10.jpg  (681.9 KiB)
    DELETE cast-gen/9/refs-4d34d48a-f7e0-4097-a552-b3ed0e7991d2.refs-job.json  (594 B)
    DELETE cast-gen/9/refs-a5198452-70c5-47f9-9db1-a8f1eb5fc6d0.refs-job.json  (908 B)
  [cast-10 LoRA, cast id 10 has no live row] -- 1 obj, 88.7 MiB
    DELETE loras/cast-10/1780807162.safetensors  (88.7 MiB)
  [cast-3 LoRA, cast id 3 has no live row] -- 6 obj, 532.5 MiB
    DELETE loras/cast-3/1780333464.safetensors  (88.7 MiB)
    DELETE loras/cast-3/1780342813.safetensors  (88.7 MiB)
    DELETE loras/cast-3/1780347620.safetensors  (88.7 MiB)
    DELETE loras/cast-3/1780411349.safetensors  (88.7 MiB)
    DELETE loras/cast-3/1780416297.safetensors  (88.8 MiB)
    DELETE loras/cast-3/1780416297.safetensors.diffusers.bak  (88.8 MiB)
  [cast-7 LoRA, cast id 7 has no live row] -- 3 obj, 266.3 MiB
    DELETE loras/cast-7/1780586926.safetensors  (88.7 MiB)
    DELETE loras/cast-7/1780621146.safetensors  (88.8 MiB)
    DELETE loras/cast-7/1780621146.safetensors.diffusers.bak  (88.8 MiB)
  [cast-8 LoRA, cast id 8 has no live row] -- 3 obj, 266.3 MiB
    DELETE loras/cast-8/1780587341.safetensors  (88.7 MiB)
    DELETE loras/cast-8/1780622927.safetensors  (88.8 MiB)
    DELETE loras/cast-8/1780622927.safetensors.diffusers.bak  (88.8 MiB)
  [cast-9 LoRA, cast id 9 has no live row] -- 1 obj, 88.7 MiB
    DELETE loras/cast-9/1780807145.safetensors  (88.7 MiB)
  [cast-scheme LoRA dir with no live cast or render reference] -- 15 obj, 666.9 MiB
    DELETE loras/lora-aria-1780941077/A/pytorch_lora_weights.safetensors  (44.5 MiB)
    DELETE loras/lora-aria-1780949897/A/pytorch_lora_weights.safetensors  (44.5 MiB)
    DELETE loras/lora-aria-1780977405/A/pytorch_lora_weights.safetensors  (44.5 MiB)
    DELETE loras/lora-companion-robot-1782198520/A/pytorch_lora_weights.safetensors  (44.5 MiB)
    DELETE loras/lora-kaito-yurei-1780949945/A/pytorch_lora_weights.safetensors  (44.5 MiB)
    DELETE loras/lora-marcus-1780941067/A/pytorch_lora_weights.safetensors  (44.5 MiB)
    DELETE loras/lora-marcus-1780949888/A/pytorch_lora_weights.safetensors  (44.5 MiB)
    DELETE loras/lora-marcus-1780977378/A/pytorch_lora_weights.safetensors  (44.5 MiB)
    DELETE loras/lora-rei-kurogane-1780941097/A/pytorch_lora_weights.safetensors  (44.5 MiB)
    DELETE loras/lora-rei-kurogane-1780949915/A/pytorch_lora_weights.safetensors  (44.5 MiB)
    DELETE loras/lora-rhode-1780941313/A/pytorch_lora_weights.safetensors  (44.5 MiB)
    DELETE loras/lora-rhode-1780949927/A/pytorch_lora_weights.safetensors  (44.5 MiB)
    DELETE loras/lora-vesper-1780941301/A/pytorch_lora_weights.safetensors  (44.5 MiB)
    DELETE loras/lora-vesper-1780943393/A/pytorch_lora_weights.safetensors  (44.5 MiB)
    DELETE loras/lora-vesper-1780948007/A/pytorch_lora_weights.safetensors  (44.5 MiB)
  [explicit operator seed (loras/wren_talks_test_2/), no live reference] -- 1 obj, 44.5 MiB
    DELETE loras/wren_talks_test_2/A/pytorch_lora_weights.safetensors  (44.5 MiB)

DRY RUN -- nothing deleted. Re-run with --apply to GC the orphan set above.
```

## Applied (2026-06-24)
Cleared to apply the full 152-object set by the lead (Conrad-confirmed; live
casts = ids 2/4/5/6/17/18/19/20, every orphan 0-ref by id + renders).

```
node scripts/r2-orphan-gc.ts --owners docs/309-r2-orphan-gc-owners.json --apply
```
Result: **deleted 152/152, 0 failures**; re-list verification: **0 orphans
remain ("orphan set is empty")**. Freed ~2.0 GiB from the `vivijure` R2 bucket.
All 223 live-cast assets + 86 out-of-scope non-cast artifacts untouched.
