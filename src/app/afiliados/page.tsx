import { getDb } from '@/db/client';
import { listLeads } from '@/features/leads/repository';
import { pipelineTotals } from '@/features/analytics/metrics';
import { businessCapabilities } from '@/config/business';
import { formatInteger } from '@/lib/format';
import { Card, PageHeader, Stat } from '../_components/ui';
import { Kanban } from '../_components/kanban';
import { ImportLeads } from '../_components/import-leads';
import { missingLabel } from '../_lib/labels';

export const dynamic = 'force-dynamic';

export default function AffiliatesPage() {
  const db = getDb();
  const capability = businessCapabilities().find((entry) => entry.id === 'affiliate_funnel');
  const enabled = capability?.enabled ?? false;
  const leads = listLeads({ funnel: 'affiliate' }, db);
  const totals = pipelineTotals('affiliate', db);

  return (
    <>
      <PageHeader
        title="Funil de afiliados"
        description="Criadores de conteúdo dentro dos temas oficiais do programa."
        actions={
          <ImportLeads
            funnel="affiliate"
            disabled={!enabled}
            disabledReason="Cadastre o programa de afiliados para habilitar a importação."
          />
        }
      />

      {!enabled ? (
        <Card className="mb-5">
          <div className="px-4 py-4">
            <p className="text-[13px] font-semibold text-warning">Funil de afiliados aguardando configuração.</p>
            <p className="mt-1 max-w-2xl text-[12.5px] leading-5 text-ink-muted">
              A arquitetura do funil está implementada e testada, mas nenhuma abordagem real será enviada enquanto os
              dados obrigatórios do programa não estiverem preenchidos em <code className="text-ink">config/business.json</code>.
              Nenhum placeholder é enviado a lead algum.
            </p>
            <ul className="mt-3 flex flex-col gap-1">
              {(capability?.missing ?? []).map((key) => (
                <li key={key} className="text-[12.5px] text-ink">
                  <span aria-hidden className="mr-2 text-ink-faint">•</span>
                  {missingLabel(key)}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Criadores" value={formatInteger(totals.discovered)} />
        <Stat label="Abordados" value={formatInteger(totals.contacted)} />
        <Stat label="Responderam" value={formatInteger(totals.replied)} />
        <Stat label="Entraram no grupo" value={formatInteger(totals.handedOff)} />
      </div>

      {leads.length === 0 ? (
        <div className="card px-6 py-14 text-center">
          <p className="text-[13px] font-semibold text-ink">Nenhum criador no funil</p>
          <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-5 text-ink-muted">
            {enabled
              ? 'Importe perfis de criadores para começar a prospecção do programa de afiliados.'
              : 'A importação será liberada assim que o programa de afiliados estiver cadastrado.'}
          </p>
        </div>
      ) : (
        <Kanban funnel="affiliate" leads={leads} />
      )}
    </>
  );
}
