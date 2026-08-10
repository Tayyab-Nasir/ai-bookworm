export default function Home() {
  return (
    <main>
      <h1>AI Bookworm</h1>
      <p>AI-assisted book publishing platform.</p>
      <p>
        Open the editor at <code>/books/[bookId]</code> (set{" "}
        <code>NEXT_PUBLIC_API_URL</code> to connect to the API; without it the
        editor runs in offline demo mode).
      </p>
    </main>
  );
}
