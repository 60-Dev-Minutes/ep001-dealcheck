const PUBLICATION_URL = 'https://60devminutes.substack.com/';
const SUBSCRIBE_URL = 'https://60devminutes.substack.com/subscribe';

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container stack-sm">
        <p>
          <a href={PUBLICATION_URL} target="_blank" rel="noopener noreferrer">
            Read about this experiment on 60 Dev Minutes
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        </p>
        <p>
          Want the next experiment?{' '}
          <a href={SUBSCRIBE_URL} target="_blank" rel="noopener noreferrer">
            Subscribe to 60 Dev Minutes
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
          .
        </p>
        <p className="small">
          Product details you enter are sent to an AI research provider (Anthropic). Don't enter personal information. We don't use accounts or
          tracking. We keep a hashed network identifier to enforce the free allowance; raw IP addresses are not stored. Reports are private to your
          browser session.
        </p>
        <p className="small">DealCheck is an experiment, not a guarantee of the lowest price, availability or future discounts.</p>
      </div>
    </footer>
  );
}
