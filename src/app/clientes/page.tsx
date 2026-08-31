import { getDb } from '@/db/client';
import { listLeads } from '@/features/leads/repository';
import { pipelineTotals, ratio } from '@/features/analytics/metrics';
import { capabilityReport } from '@/features/system/capabilities';
import { formatInteger, formatPercent } from '@/lib/format';
import { PageHeader, Stat } from '../_components/ui';
import { Kanban } from '../_components/kanban';
import { ImportLeads } from '../_components/import-leads';
import { missingLabel } from '../_lib/labels';

export const dynamic = 'force-dynamic';

export default function CustomersPage() {
  const db = getDb();
  const leads = listLeads({ funnel: 'customer' }, db);
  const totals = pipelineTotals('customer', db);
  const capability = capabilityReport(db).find((entry) => entry.id === 'customer_funnel');
  const replyRate = ratio(totals.replied, totals.contacted);

  return (
    <>
      <PageHeader
        title="Funil de clientes"
        description="Empresas dentro do ICP oficial. A etapa comercial e a disponibilidade do canal são acompanhadas separadamente."
        actions={
          <ImportLeads
            funnel="customer"
            disabled={capability?.configured === false}
            disabledReason={
              capability
                ? `Funil não configurado. Falta: ${capability.missing.map((key) => missingLabel(key)).join(', ')}.`
                : undefined
            }
          />
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Leads" value={formatInteger(totals.discovered)} />
        <Stat label="Abordados" value={formatInteger(totals.contacted)} />
        <Stat
          label="Responderam"
          value={formatInteger(totals.replied)}
          hint={replyRate === null ? 'Sem abordagens ainda' : formatPercent(replyRate, 1)}
        />
        <Stat label="Encaminhados ao WhatsApp" value={formatInteger(totals.handedOff)} />
      </div>

      {leads.length === 0 ? (
        <div className="card px-6 py-14 text-center">
          <p className="text-[13px] font-semibold text-ink">Nenhum lead no funil</p>
          <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-5 text-ink-muted">
            Importe uma lista de perfis para começar, ou configure o Chrome do operador para que a descoberta automática
            encontre perfis a partir das palavras-chave do ICP.
          </p>
        </div>
      ) : (
        <Kanban funnel="customer" leads={leads} />
      )}
    </>
  );
}
