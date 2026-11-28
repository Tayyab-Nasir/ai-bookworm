"use client";

import Image from "next/image";
import { Hand } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import styles from "../app/bookiewookie.module.css";
import BookieScene from "./BookieScene";

type Movement = { look: (x: number, y: number) => void; greet: () => void };

export default function BookieMascot({ signup = false }: { signup?: boolean }) {
  const tilt = useRef<HTMLDivElement>(null);
  const owl = useRef<HTMLDivElement>(null);
  const movement = useRef<Movement | null>(null);
  const [greeted, setGreeted] = useState(false);

  useEffect(() => {
    const target = tilt.current;
    const character = owl.current;
    if (!target || !character) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let revision = 0;
    let release: (() => void) | undefined;

    async function syncMotion() {
      const version = ++revision;
      movement.current = null;
      release?.();
      release = undefined;
      if (preference.matches) return;
      const { gsap } = await import("gsap");
      if (version !== revision || preference.matches) return;
      let greeting: ReturnType<typeof gsap.timeline> | undefined;
      const ease = { duration: 0.55, ease: "power3.out" };
      const x = gsap.quickTo(target, "x", ease);
      const y = gsap.quickTo(target, "y", ease);
      const pitch = gsap.quickTo(target, "rotationX", ease);
      const turn = gsap.quickTo(target, "rotationY", ease);
      gsap.set(target, { transformPerspective: 900 });
      movement.current = {
        look(horizontal, vertical) {
          x(horizontal * 16); y(vertical * 11);
          pitch(-vertical * 9); turn(horizontal * 12);
        },
        greet() {
          greeting?.kill();
          greeting = gsap.timeline()
            .to(character, { y: -17, rotation: -5, duration: 0.25, ease: "power2.out" })
            .to(character, { y: 0, rotation: 0, duration: 0.7, ease: "elastic.out(1, 0.63)" });
        },
      };
      release = () => {
        greeting?.kill();
        for (const control of [x, y, pitch, turn]) control.tween.kill();
        gsap.set([target, character], { clearProps: "transform" });
      };
    }

    const onPreference = () => { void syncMotion().catch(() => { movement.current = null; }); };
    preference.addEventListener("change", onPreference);
    onPreference();
    return () => { revision++; preference.removeEventListener("change", onPreference); movement.current = null; release?.(); };
  }, []);

  function followPointer(event: MouseEvent<HTMLDivElement>) {
    if (!movement.current) return;
    const box = event.currentTarget.getBoundingClientRect();
    movement.current.look((event.clientX - box.left) / box.width * 2 - 1, (event.clientY - box.top) / box.height * 2 - 1);
  }

  return <div className={`${styles.art} ${signup ? styles.signupArt : ""}`} onMouseMove={followPointer}
    onMouseLeave={() => movement.current?.look(0, 0)}>
    <span className={styles.orbit} aria-hidden />
    <div ref={tilt} className={styles.mascotTilt}>
      <div ref={owl}><Image className={styles.mascot} src="/brand/bookiewookie.webp" width={950} height={950}
        alt="BookieWookie, a paper owl in a red scarf holding a plum book" priority sizes="(max-width: 760px) 85vw, 42vw" /></div>
    </div>
    {!signup && <BookieScene />}
    <button type="button" className={styles.greet} onClick={() => {
      movement.current?.greet();
      setGreeted(true);
    }}><Hand size={17} aria-hidden /> {greeted ? "Say hello again" : "Say hello to Bookie"}</button>
    <span className="sr-only" role="status">{greeted ? "Bookie says hello." : ""}</span>
  </div>;
}
