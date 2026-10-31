import { Link } from 'react-router-dom';

/**
 * The one floating action on 今天: open quick entry.
 *
 * The shell renders it only on the today route. Its position is CSS, calculated
 * from the tab bar height and the bottom safe-area inset, so it always sits
 * above both instead of covering either.
 */
export default function Fab() {
  return (
    <Link className="fab" to="/add" aria-label="记一笔">
      <span aria-hidden="true">+</span>
    </Link>
  );
}
