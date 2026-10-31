import { Link, NavLink, useLocation } from 'react-router-dom';

/**
 * The v1 floating capsule: four labels around the centre +.
 *
 * It is the only navigation on the main screens. The + opens /add with the
 * current location in state, which raises 随手记 over the page instead of
 * replacing it. Pushed pages have no dock — App decides that from the route.
 */
const linkClass = ({ isActive }: { isActive: boolean }) =>
  isActive ? 'dock__link is-active' : 'dock__link';

export default function AppDock() {
  const location = useLocation();
  return (
    <nav className="dock" aria-label="主导航">
      <NavLink to="/" end className={linkClass}>
        今天
      </NavLink>
      <NavLink to="/ledger" className={linkClass}>
        流水
      </NavLink>
      <Link
        className="dock__plus"
        to="/add"
        state={{ backgroundLocation: location }}
        aria-label="记一笔"
      >
        <span aria-hidden="true">+</span>
      </Link>
      <NavLink to="/reports" className={linkClass}>
        报表
      </NavLink>
      <NavLink to="/settings" className={linkClass}>
        设置
      </NavLink>
    </nav>
  );
}