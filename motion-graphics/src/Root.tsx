import React from "react";
import { Composition } from "remotion";
import { FlashSale } from "./templates/FlashSale";
import { flashSaleSchema, FlashSaleProps } from "./templates/FlashSale/schema";
import { MotionGeneral } from "./general/MotionGeneral";
import { MotionGeneralShort } from "./general/MotionGeneralShort";
import { propsSchema as generalSchema, Props as GeneralProps } from "./general/schema";
import { loadFont as loadPoppins } from "@remotion/google-fonts/Poppins";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";

loadPoppins();
loadInter();

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

// Default props = contoh (Beats headphone). LLM akan override semua ini per produk.
const defaultProps: FlashSaleProps = {
  brand: { name: "ETSHOP.IN" },
  product: {
    title: "HEADPHONE",
    subtitle: "BEATS PRO",
    // ganti ke URL foto produk asli / staticFile("product.png")
    imageUrl: "https://images.unsplash.com/photo-1583394838336-acd977736f90?w=800",
    imageIsCutout: false,
  },
  sale: {
    badgeText: "FLASH SALE",
    headline: "BIG SALE",
    discount: "50% OFF",
    priceOld: "Rp1.500.000",
    priceNew: "Rp750.000",
    description: "Dengarkan musik lebih jernih. Promo spesial, hari ini saja.",
  },
  cta: { text: "SHOP NOW" },
  theme: {
    bgFrom: "#ff9d1c",
    bgTo: "#ff6a00",
    panel: "#e11d2a",
    paper: "#ffffff",
    ink: "#111111",
    paperInk: "#111111",
    onPanel: "#ffffff",
    accent: "#e11d2a",
    button: "#111111",
    buttonInk: "#ffffff",
  },
  timing: { intro: 3, badge: 3, showcase: 11, outro: 2 },
};

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

export const RemotionRoot: React.FC = () => {
  return (
    <>
    <Composition
      id="FlashSale"
      component={FlashSale}
      schema={flashSaleSchema}
      defaultProps={defaultProps}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      durationInFrames={20 * FPS}
      calculateMetadata={({ props }) => {
        const t = props.timing;
        const totalSec = t.intro + t.badge + t.showcase + t.outro;
        return {
          durationInFrames: Math.round(totalSec * FPS),
          fps: FPS,
          width: WIDTH,
          height: HEIGHT,
        };
      }}
    />
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
    </>
  );
};
