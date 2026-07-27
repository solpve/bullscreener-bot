import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="hero">
      <div className="shell">
        <div className="hero__label">
          <span className="micro">404</span>
        </div>
        <h1>No such page.</h1>
        <p className="prose hero__lede">
          Nothing is here. The screener, the burn log and the deployer
          instructions are all one click away.
        </p>
        <div className="hero__actions">
          <Link className="btn btn--primary" href="/">
            Screener
          </Link>
          <Link className="btn" href="/burns">
            Burn log
          </Link>
        </div>
      </div>
    </section>
  );
}
