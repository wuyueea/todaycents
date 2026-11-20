import { Link, useParams } from 'react-router-dom';
import { ProjectTxnList } from '../components/ProjectTxnList';
import { useRestoreTxnEditScroll, type TxnEditOrigin } from '../components/TxnEditNavigation';
import { projectTransactions } from '../db/repos/projects';
import { useQuery } from '../store/useDb';

export default function ProjectTransactionsScreen({ editReturn }: { editReturn: TxnEditOrigin | null }) {
  const { id = '' } = useParams<{ id: string }>();
  const query = useQuery(db => projectTransactions(db, id), [id]);
  const data = query.data?.project.id === id ? query.data : null;
  useRestoreTxnEditScroll(editReturn, data !== null && !query.loading);
  const projectPath = `/settings/projects/${encodeURIComponent(id)}`;

  return (
    <div className="project-detail-screen project-detail-screen--v1">
      <header className="settings-header">
        <Link className="add-back" to={projectPath} replace aria-label="返回项目详情">‹</Link>
        <h1>项目流水</h1>
        {data && <span className="settings-header__meta">{data.rows.length} 笔</span>}
      </header>
      {data ? (
        <section className="project-section-block" aria-labelledby="project-transactions-name">
          <h2 className="project-transactions__name" id="project-transactions-name">{data.project.name}</h2>
          {data.rows.length > 0 ? <ProjectTxnList rows={data.rows} includeYear /> : (
            <p className="project-detail-note">这个项目还没有流水</p>
          )}
        </section>
      ) : (
        query.error
          ? <p className="project-detail-note project-detail-note--error" role="alert">项目流水暂时打不开</p>
          : <p className="project-detail-note" role="status">正在读取项目流水…</p>
      )}
    </div>
  );
}
