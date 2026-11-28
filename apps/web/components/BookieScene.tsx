"use client";

import { useEffect, useRef, useState } from "react";
import styles from "../app/bookiewookie.module.css";

export default function BookieScene() {
  const host = useRef<HTMLDivElement>(null);
  const [motionEnabled, setMotionEnabled] = useState(false);

  useEffect(() => {
    const preference = window.matchMedia("(min-width: 761px) and (prefers-reduced-motion: no-preference)");
    const syncPreference = () => setMotionEnabled(preference.matches);
    preference.addEventListener("change", syncPreference);
    syncPreference();
    return () => preference.removeEventListener("change", syncPreference);
  }, []);

  useEffect(() => {
    const element = host.current;
    if (!element || !motionEnabled) return;
    let cancelled = false;
    let release: (() => void) | undefined;

    async function mount(container: HTMLDivElement) {
      const [T, F, { gsap }] = await Promise.all([import("three"), import("fabric"), import("gsap")]);
      if (cancelled) return;
      const cover = new F.StaticCanvas(document.createElement("canvas"), { width: 256, height: 360, backgroundColor: "#442443", enableRetinaScaling: false });
      release = () => { void cover.dispose(); };
      const mascot = await F.FabricImage.fromURL("/brand/bookiewookie.webp");
      if (cancelled) return;
      mascot.scaleToWidth(174);
      mascot.set({ left: 41, top: 77, originX: 'left', originY: 'top' });
      cover.add(
        new F.Rect({ left: 16, top: 16, originX: 'left', originY: 'top', width: 223, height: 327, rx: 9, ry: 9, fill: "transparent", stroke: "#e9bb72", strokeWidth: 2 }),
        mascot,
        new F.FabricText("BookieWookie", { left: 128, top: 27, originX: "center", originY: "top", fill: "#fff1cb", fontSize: 26, fontFamily: "Georgia" }),
      );
      cover.renderAll();

      const renderer = new T.WebGLRenderer({ alpha: true, antialias: true });
      const scene = new T.Scene();
      const camera = new T.PerspectiveCamera(33, 1, 0.1, 20);
      camera.position.z = 5.9;
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
      const texture = new T.CanvasTexture(cover.getElement());
      texture.colorSpace = T.SRGBColorSpace;
      const paper = new T.MeshBasicMaterial({ color: "#e4c893" });
      const spine = new T.MeshBasicMaterial({ color: "#6a365b" });
      const front = new T.MeshBasicMaterial({ map: texture });
      const geometry = new T.BoxGeometry(1.3, 1.82, .21);
      const book = new T.Mesh(geometry, [paper, spine, paper, paper, front, spine]);
      book.rotation.set(.12, -.36, -.18);
      scene.add(book);
      container.append(renderer.domElement);

      const draw = () => renderer.render(scene, camera);
      const resize = new ResizeObserver(() => {
        if (!container.clientWidth || !container.clientHeight) return;
        camera.aspect = container.clientWidth / container.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(container.clientWidth, container.clientHeight, false);
        draw();
      });
      resize.observe(container);
      const tilt = gsap.quickTo(book.rotation, "y", { duration: .55, ease: "power3.out", onUpdate: draw });
      const move = (event: PointerEvent) => {
        if (event.pointerType !== "mouse") return;
        const bounds = container.getBoundingClientRect();
        tilt(-.36 + Math.max(-.8, Math.min(.8, (event.clientX - bounds.left) / bounds.width - .5)));
      };
      const reset = () => tilt(-.36);
      container.addEventListener("pointermove", move);
      container.addEventListener("pointerleave", reset);
      const useStaticMascot = () => {
        release?.();
        release = undefined;
      };
      renderer.domElement.addEventListener("webglcontextlost", useStaticMascot);
      release = () => {
        container.removeEventListener("pointermove", move);
        container.removeEventListener("pointerleave", reset);
        renderer.domElement.removeEventListener("webglcontextlost", useStaticMascot);
        tilt.tween.kill();
        resize.disconnect();
        geometry.dispose();
        texture.dispose();
        [paper, spine, front].forEach(material => material.dispose());
        renderer.dispose();
        renderer.domElement.remove();
        void cover.dispose();
      };
    }

    void mount(element).catch(() => { release?.(); release = undefined; });
    return () => { cancelled = true; release?.(); };
  }, [motionEnabled]);

  return <div ref={host} className={styles.scene} aria-hidden="true" />;
}
