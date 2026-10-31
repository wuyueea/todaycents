import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import AppDock from './components/AppDock';
import TodayScreen from './screens/TodayScreen';
import QuickEntryScreen from './screens/QuickEntryScreen';
import LedgerScreen from './screens/LedgerScreen';
import TxnEditScreen from './screens/TxnEditScreen';
import AccountsScreen from './screens/AccountsScreen';
import SettingsScreen from './screens/SettingsScreen';
import BackupScreen from './screens/BackupScreen';
import TagsScreen from './screens/TagsScreen';
import CategoriesScreen from './screens/CategoriesScreen';
import ProjectsScreen from './screens/ProjectsScreen';
import ProjectDetailScreen from './screens/ProjectDetailScreen';
import FixedCostsScreen from './screens/FixedCostsScreen';
import ReportsScreen from './screens/ReportsScreen';
import StorageScreen from './screens/StorageScreen';
import { useDb } from './store/useDb';

/**
 * Where the retired /transfer page sends anyone who still points at it.
 *
 * 转账 now lives inside 随手记, so /transfer is only a compatibility redirect:
 * an old bookmark or a stale link lands on the entry form instead of a blank
 * route. Exported so the test can pin the destination without a DOM.
 */
export const LEGACY_TRANSFER_TARGET = '/add';

/**
 * App shell: the floating dock frame the router renders screens into.
 *
 * The database is opened here, not inside the screens, so a browser without
 * the native layer still gets a usable frame: the status line says the data
 * layer is not ready and the placeholder screens keep rendering. Network is
 * never involved; the only data path is the local SQLite singleton.
 */
export default function App() {
  const { db, error } = useDb();
  const location = useLocation();
  const navigate = useNavigate();
  const isEntryOpen = location.pathname === '/add';
  // Opening 随手记 keeps the page underneath mounted: the + navigates to /add
  // with the current location in state, and the base Routes render that saved
  // location. A direct /add (a stale link) has no saved page, so 今天 stands in.
  const backgroundLocation = (
    location.state as { backgroundLocation?: typeof location } | null
  )?.backgroundLocation;
  const baseLocation = isEntryOpen
    ? (backgroundLocation ?? { ...location, pathname: '/', search: '', hash: '' })
    : location;
  // 设置 is the fourth label; everything under it — and 账户, which moved
  // there when 设置 took its place — is a pushed page, so the dock steps out of
  // the way and the page owns the whole viewport. The centre + lives in the
  // dock on every tab.
  const isFullScreen = /^\/(add|transfer|accounts|txn\/[^/]+|settings\/.+)\/?$/.test(
    location.pathname
  );
  // 今天、流水、报表 and 设置 own their edge-to-edge padding on the v1
  // layout; the pushed pages still use the old shell until their turn.
  const isV1Main =
    baseLocation.pathname === '/' ||
    baseLocation.pathname === '/ledger' ||
    baseLocation.pathname === '/reports' ||
    baseLocation.pathname === '/settings' ||
    baseLocation.pathname === '/accounts' ||
    baseLocation.pathname.startsWith('/txn/') ||
    baseLocation.pathname === '/settings/categories' ||
    baseLocation.pathname === '/settings/tags' ||
    baseLocation.pathname === '/settings/projects' ||
    baseLocation.pathname.startsWith('/settings/projects/') ||
    baseLocation.pathname === '/settings/fixed' ||
    baseLocation.pathname === '/settings/backup' ||
    baseLocation.pathname === '/settings/storage';
  const status = db ? null : error ? '数据层未就绪' : '正在加载数据…';

  return (
    <div
      className={isFullScreen ? 'app-shell app-shell--full' : 'app-shell'}
      data-testid="app-root"
    >
      {/* The Android status bar floats over the WebView; without this the
          scrolling page slides underneath it. A fixed translucent strip keeps
          the app's content below the bar while the bar stays legible. */}
      <div className="status-veil" aria-hidden="true" />

      <main className={isV1Main ? 'app-main app-main--v1' : 'app-main'}>
        {status !== null && (
          <p className="app-db-status" role="status">
            {status}
          </p>
        )}

        <Routes location={baseLocation}>
          <Route path="/" element={<TodayScreen />} />
          <Route path="/ledger" element={<LedgerScreen />} />
          <Route path="/reports" element={<ReportsScreen />} />
          <Route path="/accounts" element={<AccountsScreen />} />
          {/* The old transfer page is gone; its links land on 随手记. */}
          <Route path="/transfer" element={<Navigate to={LEGACY_TRANSFER_TARGET} replace />} />
          <Route path="/txn/:id" element={<TxnEditScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="/settings/backup" element={<BackupScreen />} />
          <Route path="/settings/storage" element={<StorageScreen />} />
          <Route path="/settings/tags" element={<TagsScreen />} />
          <Route path="/settings/categories" element={<CategoriesScreen />} />
          <Route path="/settings/projects" element={<ProjectsScreen />} />
          <Route path="/settings/projects/:id" element={<ProjectDetailScreen />} />
          <Route path="/settings/fixed" element={<FixedCostsScreen />} />
          {/* Unknown paths go back to 今天 rather than rendering a blank page. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {isEntryOpen && (
        <QuickEntryScreen
          onClose={() => {
            if (backgroundLocation) navigate(-1);
            else navigate('/', { replace: true });
          }}
        />
      )}

      {!isFullScreen && <AppDock />}
    </div>
  );
}