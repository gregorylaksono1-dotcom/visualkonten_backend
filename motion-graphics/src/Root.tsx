import React from "react";
import { Composition } from "remotion";

import { MotionGeneral } from "./general/MotionGeneral";
import { MotionGeneralShort } from "./general/MotionGeneralShort";
import { propsSchema as generalSchema, Props as GeneralProps } from "./general/schema";
import { MotionCV } from "./cv/MotionCV";
import { cvSchema, CvProps } from "./cv/schema";
import { loadFont as loadPoppins } from "@remotion/google-fonts/Poppins";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";

loadPoppins();
loadInter();

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;



const defaultPropsGeneral: GeneralProps = {
  status: "ok",
  template: "motion_general_v1",
  engine: "remotion",
  format: "9:16",
  duration_sec: 15,
  theme: {
    palette: { brandA: "#ff9d1c", brandB: "#ff6a00", accent: "#e11d2a", ink: "#111111" },
    mood: "fresh",
  },
  product: {
    name: "TROPICANA SLIM",
    image: "fruit",
    imageUrl: "https://images.unsplash.com/photo-1546173159-315724a31696?w=800",
    image_is_cutout: true,
    tagline: "SEGAR 100%",
  },
  accent: {
    mode: "particles",
    shape: "fruit",
    behavior: "fall",
    colors: ["#ff9d1c", "#ff6a00", "#e11d2a"],
    density: "med",
    asset: null,
  },
  scenes: [
    {
      id: "hook",
      enabled: true,
      start_sec: 0,
      end_sec: 3,
      headline: "SEGARNYA",
      sub: "Bikin Nagih",
    },
    {
      id: "reveal",
      enabled: true,
      start_sec: 3,
      end_sec: 8,
      product_name: "TROPICANA SLIM",
      tagline: "Minuman Jeruk Asli",
    },
    {
      id: "features",
      enabled: true,
      start_sec: 8,
      end_sec: 12,
      headline: "Keunggulan",
      items: ["Tanpa Gula", "Vitamin C", "Halal MUI"],
    },
    {
      id: "offer",
      enabled: true,
      start_sec: 12,
      end_sec: 15,
      badge: "PROMO",
      now: "50%",
      unit: "OFF",
    }
  ],
};

const defaultPropsCV: CvProps = {
  status: "ok",
  template: "motion_cv_v1",
  engine: "remotion",
  format: "9:16",
  duration_sec: 24,
  field: "design",
  theme: { kit: "creative", seed: 2 },
  person: {
    name: "Andi Pratama",
    role: "Graphic Designer",
    image: "provided_reference",
    imageUrl: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800",
    image_subject: "person",
    tagline: "Bikin brand jadi hidup",
  },
  skills: [
    { name: "Brand & Visual Identity", level: 92 },
    { name: "UI/UX Design", level: 85 },
    { name: "Motion Graphics", level: 78 },
    { name: "Figma & After Effects", level: 88 },
  ],
  summary: "Desainer yang mengubah ide kompleks jadi visual sederhana & berdampak. Fokus pada brand yang tumbuh lewat desain.",
  soft_skills: ["Komunikatif", "Detail-oriented", "Problem Solver", "Kolaboratif"],
  experience: ["Sr. Designer @ Tokopedia", "Designer @ Gojek", "Freelance 50+ klien", "Mentor UI/UX Bootcamp", "Speaker Design Meetup"],
  highlight: { label: "Pengalaman", value: "6 Tahun" },
  contact: { email: "andi@email.com", handle: "@andi.design", cta: "Mari Berkolaborasi" },
};

export const RemotionRoot: React.FC = () => {
  return (
    <>

    <Composition
      id="MotionGeneral"
      component={MotionGeneral}
      schema={generalSchema}
      defaultProps={defaultPropsGeneral}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      durationInFrames={15 * FPS}
      calculateMetadata={({ props }) => {
        return {
          durationInFrames: Math.round(props.duration_sec * FPS),
          fps: FPS,
          width: WIDTH,
          height: HEIGHT,
        };
      }}
    />
    <Composition
      id="MotionGeneralShort"
      component={MotionGeneralShort}
      schema={generalSchema}
      defaultProps={{ ...defaultPropsGeneral, duration_sec: 10 }}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      durationInFrames={10 * FPS}
      calculateMetadata={({ props }) => {
        return {
          durationInFrames: Math.round(props.duration_sec * FPS),
          fps: FPS,
          width: WIDTH,
          height: HEIGHT,
        };
      }}
    />
    <Composition
      id="MotionCV"
      component={MotionCV}
      schema={cvSchema}
      defaultProps={defaultPropsCV}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      durationInFrames={24 * FPS}
      calculateMetadata={({ props }) => {
        return {
          durationInFrames: Math.round(props.duration_sec * FPS),
          fps: FPS,
          width: WIDTH,
          height: HEIGHT,
        };
      }}
    />
    </>
  );
};
