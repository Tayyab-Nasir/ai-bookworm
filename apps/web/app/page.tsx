import Link from "next/link";
import Image from "next/image";
import { ArrowDownRight, ArrowUpRight, BookOpen, Feather, Layers3 } from "lucide-react";
import BookieScene from "../components/BookieScene";
import styles from "./bookiewookie.module.css";

const stages = [
  { title: "Write the book", text: "Bring a manuscript or start with a blank page. Keep drafts, revisions, and story notes together.", Icon: Feather },
  { title: "Make it yours", text: "Build a Book Bible, develop illustrations, and prepare the layout and cover for your edition.", Icon: Layers3 },
  { title: "Prepare to publish", text: "Review private EPUB and print proofs, then prepare files for your chosen retailer.", Icon: BookOpen },
];

const studioTools = [
  { title: "Manuscript & Book Bible", text: "Import a draft, edit chapters, and keep characters, settings, and story details close as the manuscript evolves." },
  { title: "Artwork & covers", text: "Keep illustrations and cover drafts in a private library. Choose the artwork for each edition." },
  { title: "Print & ebook design", text: "Set trim size, typography, and spacing. Review the saved PDF or EPUB before you export." },
  { title: "Release & sales tracking", text: "Keep package history, retailer submission status, and imported sales reports with your books." },
];

const publishingSteps = [
  { title: "Check the edition", text: "Run preflight and review the files for your chosen retailer." },
  { title: "Download the package", text: "Get the proof, cover, and listing materials prepared for that channel." },
  { title: "Track the release", text: "Record a submission and its review status as the retailer processes it." },
];

export default function Home() {
  return <main className={styles.site}>
    <header className={styles.header}>
      <Link href="/" className={styles.brand}><Image src="/brand/mark.png" width={36} height={36} alt="" />BookieWookie</Link>
      <nav aria-label="Main navigation" className={styles.nav}>
        <a className={styles.sectionLink} href="#studio">The studio</a>
        <a className={styles.sectionLink} href="#features">Features</a>
        <a className={styles.sectionLink} href="#publishing">Publishing</a>
        <Link href="/login">Sign in</Link>
      </nav>
      <Link href="/signup" className={styles.headerAction}>Get started <ArrowUpRight size={15} aria-hidden /></Link>
    </header>

    <section className={styles.hero} aria-labelledby="hero-title">
      <div className={styles.intro}>
        <p className={styles.eyebrow}>THE AUTHOR’S PUBLISHING STUDIO</p>
        <h1 id="hero-title">Make a book<br /> <em>worth opening.</em></h1>
        <p className={styles.lede}>Write, illustrate, and prepare your book for publication in a private workspace built for authors.</p>
        <div className={styles.actions}>
          <Link href="/signup" className={styles.primary}>Start your book <ArrowUpRight size={19} aria-hidden /></Link>
          <a href="#studio" className={styles.secondary}>Explore the studio <ArrowDownRight size={18} aria-hidden /></a>
        </div>
      </div>
      <div className={styles.art}>
        <span className={styles.orbit} aria-hidden />
        <Image className={styles.mascot} src="/brand/bookiewookie.webp" width={950} height={950} alt="BookieWookie, a paper owl wearing a red bookmark scarf and holding a plum book" priority sizes="(max-width: 760px) 85vw, 42vw" />
        <BookieScene />
      </div>
    </section>

    <section id="studio" className={styles.studio} aria-labelledby="studio-title">
      <h2 id="studio-title">From manuscript to edition</h2>
      <div className={styles.stages}>{stages.map(({ title, text, Icon }) => <article key={title}>
        <Icon size={23} aria-hidden /><h3>{title}</h3><p>{text}</p>
      </article>)}</div>
    </section>

    <section id="features" className={styles.features} aria-labelledby="features-title">
      <div>
        <h2 id="features-title">A studio for <em>the whole book.</em></h2>
        <p>Your manuscript, artwork, and editions stay connected to one project, so you can pick up where you left off.</p>
      </div>
      <dl className={styles.toolIndex}>{studioTools.map(({ title, text }) => <div key={title}>
        <dt>{title}</dt><dd>{text}</dd>
      </div>)}</dl>
    </section>

    <section id="publishing" className={styles.publishing} aria-labelledby="publishing-title">
      <div>
        <h2 id="publishing-title">Ready for <em>the bookshelf.</em></h2>
        <p>Prepare channel-specific packages for Amazon KDP, Barnes &amp; Noble Press, and other retailers. Each retailer reviews submissions.</p>
      </div>
      <ol className={styles.publishingSteps}>{publishingSteps.map(({ title, text }) => <li key={title}>
        <h3>{title}</h3><p>{text}</p>
      </li>)}</ol>
    </section>

    <section className={styles.closing} aria-labelledby="closing-title">
      <div>
        <h2 id="closing-title">Your next book <em>starts here.</em></h2>
        <p>Bring a manuscript or open a blank page. AI generation availability depends on your plan and provider settings.</p>
      </div>
      <Link href="/signup" className={styles.primary}>Create your workspace <ArrowUpRight size={19} aria-hidden /></Link>
    </section>
    <footer className={styles.footer}><Link href="/">BookieWookie</Link><span>Bookiewookie.app</span><Link href="/login">Open your studio</Link></footer>
  </main>;
}
