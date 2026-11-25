import { PUBLICATION_URL, SUBSCRIBE_URL } from '../util';

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
          <a href={SUBSCRIBE_URL}>Subscribe to 60 Dev Minutes</a>
          .
        </p>
        <p className="small">
          Product details you enter are sent to an AI research provider (Anthropic). Don't enter personal information. We don't use accounts or
          tracking. We keep a hashed network identifier to enforce the free allowance; raw IP addresses are not stored. Reports are private to your
          browser session. The "Recently checked" list publicly shows the product name we identified, the market and the verdict of completed
          checks — never what you typed, your price or anything that identifies you. The subscribe form is provided by Substack and only loads if you choose to subscribe.
        </p>
        <p className="small">DealCheck is an experiment, not a guarantee of the lowest price, availability or future discounts.</p>
      </div>
    </footer>
  );
}
