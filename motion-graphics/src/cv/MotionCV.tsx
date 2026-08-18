import React, { useMemo } from "react";
import { AbsoluteFill, Sequence, useVideoConfig, Audio, interpolate } from "remotion";
import { CvProps, cvSchema } from "./schema";
import { resolveCvPalette } from "./theme";
import { CvScene } from "./scenes/CvScene";
import { CvPhoto } from "./scenes/CvPhoto";
import { CvSkills } from "./scenes/CvSkills";
import { SceneTransition, TransitionType } from "../general/scenes/SceneTransition";

// Transisi KHAS per jenis scene (bukan cycling) → tiap scene punya karakter sendiri.
const CV_TRANS_BY_KEY: Record<string, TransitionType> = {
  intro: "zoomIn", photo: "diagonal", role: "slideUp", skills: "slideRight",
  soft: "zoomIn", exp: "wipe", hl: "flip", contact: "diagonal",
};
const CV_TRANS_FALLBACK: TransitionType[] = ["diagonal", "slideUp", "zoomIn", "wipe", "slideRight"];
// Cherry-pick: maksimal pengalaman yang ditampilkan (sisanya tak ditampilkan).
const MAX_EXP = 4;

export const MotionCV: React.FC<CvProps> = (props) => {
  const safe = useMemo(() => {
    try { return cvSchema.parse(props); } catch (e) { console.warn("CV props invalid", e); return props; }
  }, [props]);

  const { fps, durationInFrames } = useVideoConfig();
  const pal = resolveCvPalette(safe.theme, safe.field);

  // Susun segmen (hanya yang ada datanya) + bobot durasi relatif.
  const segments = useMemo(() => {
    const segs: { key: string; weight: number; node: React.ReactNode }[] = [];
    // intro: nama besar + diagonal split (khas "Halo!")
    segs.push({ key: "intro", weight: 2.0, node: <CvScene palette={pal} eyebrow="Halo!" title={safe.person.name} align="center" motif="diagonal" /> });
    const finalImageUrl = safe.imageUrl || safe.person.imageUrl || safe.person.image;
    if (finalImageUrl) segs.push({ key: "photo", weight: 3.4, node: <CvPhoto palette={pal} name={safe.person.name} role={safe.person.role} imageUrl={finalImageUrl} /> });
    // Profil: role BESAR + ringkasan (summary), rata kiri + motif lingkaran
    segs.push({ key: "role", weight: 3.0, node: <CvScene palette={pal} eyebrow="Profil" title={safe.person.role} sub={safe.person.tagline || undefined} body={safe.summary || undefined} align="left" motif="circle" /> });
    if (safe.skills?.length) segs.push({ key: "skills", weight: 3.8, node: <CvSkills palette={pal} skills={safe.skills} /> });
    // Soft skills (chips) + motif dots
    if (safe.soft_skills?.length) segs.push({ key: "soft", weight: 2.8, node: <CvScene palette={pal} eyebrow="Soft Skills" chips={safe.soft_skills.slice(0, 6)} align="center" motif="dots" /> });
    // Pengalaman: CHERRY-PICK top-N + motif stripe, rata kiri
    if (safe.experience?.length) segs.push({ key: "exp", weight: 3.6, node: <CvScene palette={pal} eyebrow="Pengalaman" items={safe.experience.slice(0, MAX_EXP)} align="left" motif="stripe" /> });
    if (safe.highlight) segs.push({ key: "hl", weight: 2.2, node: <CvScene palette={pal} eyebrow={safe.highlight.label} big={safe.highlight.value} align="center" motif="blocks" /> });
    segs.push({ key: "contact", weight: 3.0, node: <CvScene palette={pal} eyebrow="Kontak" title={safe.contact?.cta || "Mari Berkolaborasi"} sub={[safe.contact?.email, safe.contact?.handle].filter(Boolean).join("  ·  ")} align="center" motif="diagonal" /> });
    return segs;
  }, [safe, pal]);

  const totalW = segments.reduce((a, s) => a + s.weight, 0);

  let acc = 0;
  const placed = segments.map((s, i) => {
    const dur = Math.round((s.weight / totalW) * durationInFrames);
    const from = acc;
    acc += dur;
    // scene terakhir menutup sisa frame
    const durationFinal = i === segments.length - 1 ? durationInFrames - from : dur;
    return { ...s, from, durationFinal, type: CV_TRANS_BY_KEY[s.key] ?? CV_TRANS_FALLBACK[i % CV_TRANS_FALLBACK.length] };
  });

  return (
    <AbsoluteFill style={{ backgroundColor: pal.bg }}>
      {placed.map((s) => (
        <Sequence key={s.key} from={s.from} durationInFrames={Math.max(1, s.durationFinal)}>
          <SceneTransition type={s.type} durationInFrames={Math.max(1, s.durationFinal)}>
            {s.node}
          </SceneTransition>
        </Sequence>
      ))}

      {safe.music?.audioUrl && (
        <Audio src={safe.music.audioUrl} loop
          volume={(f) => interpolate(f, [durationInFrames - fps * 1.5, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} />
      )}
    </AbsoluteFill>
  );
};
