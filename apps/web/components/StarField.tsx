"use client";

const stars = [
  { top: "8%", left: "12%", size: 1.5, d: 5.2 },
  { top: "14%", left: "32%", size: 1, d: 6.8 },
  { top: "6%", left: "55%", size: 1.2, d: 4.4 },
  { top: "20%", left: "72%", size: 1.8, d: 7.6 },
  { top: "11%", left: "88%", size: 1, d: 5.9 },
  { top: "32%", left: "8%", size: 1.4, d: 6.2 },
  { top: "44%", left: "22%", size: 1, d: 4.9 },
  { top: "62%", left: "30%", size: 1.2, d: 7.3 },
  { top: "70%", left: "78%", size: 1.5, d: 5.6 },
  { top: "78%", left: "92%", size: 1, d: 6.5 },
  { top: "84%", left: "14%", size: 1.3, d: 5.1 },
  { top: "90%", left: "60%", size: 1, d: 6.9 },
] as const;

export default function StarField() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      {stars.map((s, i) => (
        <span
          key={i}
          className="absolute rounded-full bg-white"
          style={{
            top: s.top,
            left: s.left,
            width: `${s.size}px`,
            height: `${s.size}px`,
            opacity: 0.7,
            boxShadow: `0 0 ${s.size * 4}px rgba(255,255,255,0.6)`,
            animation: `star-twinkle ${s.d}s ease-in-out infinite`,
            animationDelay: `${i * 0.27}s`,
          }}
        />
      ))}
    </div>
  );
}
