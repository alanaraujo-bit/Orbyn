import { getDb } from '@/db/client';
import { getBusinessConfig, loadBusinessConfig, BUSINESS_CONFIG_PATH } from '@/config/business';
import { capabilityReport } from '@/features/system/capabilities';
import { verifyConfigIntegrity } from '@/features/system/config-integrity';
import { listBackups } from '@/db/backup';
import { breakerStatus } from '@/lib/circuit-breaker';
import { databaseFilePath, getEnv } from '@/lib/env';
import { formatBytes, formatDateTime, formatInteger } from '@/lib/format';
import { Card, EmptyState, Field, PageHeader, Pill, TableShell, Td, Th } from '../_components/ui';
import { ActionButton } from '../_components/action-button';
import { pauseCapabilityAction, resumeCapabilityAction, runBackupAction } from '../_actions/operations';
import { isValidHandle, normalizeHandle, profileUrl } from '@/features/leads/handle';
import { CAPABILITY_LABELS, missingLabel } from '../_lib/labels';

export const dynamic = 'force-dynamic';

const BREAKER_LABELS: Record<string, string> = {
  browser: 'Navegador',
  instagram_api: 'API do Instagram',
  openai: 'OpenAI',
  webhook: 'Webhook',
};

/**
 * A value that is also a destination.
 *
 * On a phone these are the settings worth acting on rather than reading: the
 * WhatsApp link opens WhatsApp, the handle opens Instagram. Shown as plain text
 * they were the only dead ends on the screen. The target is a thumb-sized row
 * on touch, and the address still wraps rather than pushing the card wide.
 */
function ExternalValue({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex min-h-11 items-center break-all text-accent-ink hover:underline md:min-h-0"
    >
      {children}
    </a>
  );
}

export default function SettingsPage() {
  const db = getDb();
  const env = getEnv();
  const config = getBusinessConfig();
  const { fingerprint, loadedAt } = loadBusinessConfig();
  const integrity = verifyConfigIntegrity(db);
  const capabilities = capabilityReport(db);
  const backups = listBackups().slice(0, 8);

  return (
    <>
      <PageHeader
        title="Configurações"
        description="O cadastro oficial do negócio é somente leitura para o sistema. Apenas o operador o altera, editando o arquivo diretamente."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card
          title="Cadastro oficial do negócio"
          description={BUSINESS_CONFIG_PATH}
          actions={<Pill tone={integrity.changed ? 'warning' : 'neutral'}>{fingerprint.slice(0, 12)}</Pill>}
        >
          <dl className="divide-y divide-line px-4 py-1">
            <Field label="Empresa">{config.company.name}</Field>
            <Field label="Responsável">
              {config.owner.name} — {config.owner.role}
            </Field>
            <Field label="Site">
              <ExternalValue href={config.company.website}>{config.company.website}</ExternalValue>
            </Field>
            <Field label="Instagram">
              {/* The configured handle carries its "@"; the profile URL must not. */}
              {isValidHandle(config.company.instagramHandle) ? (
                <ExternalValue href={profileUrl(normalizeHandle(config.company.instagramHandle))}>
                  {config.company.instagramHandle}
                </ExternalValue>
              ) : (
                config.company.instagramHandle
              )}
            </Field>
            <Field label="WhatsApp">
              {config.links.whatsapp ? (
                <ExternalValue href={config.links.whatsapp}>{config.links.whatsapp}</ExternalValue>
              ) : (
                'não configurado'
              )}
            </Field>
            <Field label="Geografia">{config.geography}</Field>
            <Field label="Afirmações verificadas">{formatInteger(config.verifiedClaims.length)}</Field>
            <Field label="Afirmações bloqueadas">{formatInteger(config.unverifiedClaims.length)}</Field>
            <Field label="Lido em">{formatDateTime(loadedAt)}</Field>
          </dl>
          <p className="border-t border-line px-4 py-2.5 text-[12px] text-ink-muted">
            Nenhuma rotina do sistema escreve neste arquivo. O aprendizado do motor de otimização fica em um armazenamento
            separado, visível na página de experimentos.
          </p>
        </Card>

        <Card title="Afirmações permitidas" description="Única base factual que a IA pode usar sobre a empresa.">
          <ul className="divide-y divide-line">
            {config.verifiedClaims.map((claim) => (
              <li key={claim} className="flex gap-2 px-4 py-2 text-[12.5px] text-ink">
                <span aria-hidden className="text-positive">
                  ✓
                </span>
                <span>{claim}</span>
              </li>
            ))}
            {config.unverifiedClaims.map((claim) => (
              <li key={claim} className="flex gap-2 px-4 py-2 text-[12.5px] text-ink-muted">
                <span aria-hidden className="text-danger">
                  ✕
                </span>
                <span>{claim}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="Capacidades" description="O que está configurado, o que está pausado e por quê." className="mt-4">
        <TableShell
          head={
            <>
              <Th role="title">Capacidade</Th>
              <Th role="badge">Situação</Th>
              <Th>Pendências</Th>
              <Th role="action" className="text-right">Controle</Th>
            </>
          }
        >
          {capabilities.map((capability) => (
            <tr key={capability.id}>
              <Td className="font-medium">{CAPABILITY_LABELS[capability.id]}</Td>
              <Td>
                <Pill tone={capability.usable ? 'positive' : capability.paused ? 'danger' : 'warning'}>
                  {capability.usable ? 'Ativa' : capability.paused ? 'Pausada' : 'Não configurada'}
                </Pill>
                {capability.pauseReason ? (
                  <p className="mt-1 text-[11.5px] text-ink-muted">{capability.pauseReason}</p>
                ) : null}
              </Td>
              <Td className="text-ink-muted">
                {capability.missing.length === 0 ? '—' : capability.missing.map((key) => missingLabel(key)).join(', ')}
              </Td>
              <Td className="text-right">
                {capability.paused ? (
                  <ActionButton variant="secondary" action={resumeCapabilityAction.bind(null, capability.id)}>
                    Retomar
                  </ActionButton>
                ) : (
                  <ActionButton
                    variant="ghost"
                    action={pauseCapabilityAction.bind(null, capability.id, 'Pausa manual pelo painel')}
                  >
                    Pausar
                  </ActionButton>
                )}
              </Td>
            </tr>
          ))}
        </TableShell>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Limites operacionais" description="Definidos no .env. São tetos, não metas.">
          <dl className="divide-y divide-line px-4 py-1">
            <Field label="DMs por dia">{formatInteger(env.MAX_DMS_PER_DAY)}</Field>
            <Field label="Intervalo entre DMs">
              {env.MIN_SECONDS_BETWEEN_DMS}s a {env.MAX_SECONDS_BETWEEN_DMS}s
            </Field>
            <Field label="Horário de operação">
              {env.OPERATING_HOURS} ({env.OPERATING_TIMEZONE})
            </Field>
            <Field label="Orçamento mensal de IA">US$ {env.OPENAI_MONTHLY_BUDGET_USD.toFixed(2)}</Field>
            <Field label="Modelos">
              {env.OPENAI_MODEL} · {env.OPENAI_MODEL_FAST}
            </Field>
            <Field label="Retenção de dados">{formatInteger(env.DATA_RETENTION_DAYS)} dias</Field>
            <Field label="Banco de dados">{databaseFilePath()}</Field>
          </dl>
        </Card>

        <div className="flex flex-col gap-4">
          <Card title="Disjuntores" description="Abrem sozinhos quando uma integração falha em sequência.">
            <TableShell
              head={
                <>
                  <Th role="title">Integração</Th>
                  <Th role="badge">Estado</Th>
                  <Th role="meta" className="text-right">Próxima tentativa</Th>
                </>
              }
            >
              {(['browser', 'instagram_api', 'openai', 'webhook'] as const).map((name) => {
                const status = breakerStatus(name, db);
                return (
                  <tr key={name}>
                    <Td>{BREAKER_LABELS[name]}</Td>
                    <Td>
                      <Pill tone={status.state === 'closed' ? 'positive' : status.state === 'open' ? 'danger' : 'warning'}>
                        {status.state === 'closed' ? 'Fechado' : status.state === 'open' ? 'Aberto' : 'Meio aberto'}
                      </Pill>
                    </Td>
                    <Td className="text-right whitespace-nowrap text-ink-muted">
                      {status.nextAttemptAt ? formatDateTime(status.nextAttemptAt) : '—'}
                    </Td>
                  </tr>
                );
              })}
            </TableShell>
          </Card>

          <Card
            title="Backups"
            description="Cópia consistente do banco, feita pela API de backup do SQLite."
            actions={
              <ActionButton variant="secondary" action={runBackupAction}>
                Fazer backup agora
              </ActionButton>
            }
          >
            {backups.length === 0 ? (
              <EmptyState
                title="Nenhum backup ainda"
                description="O worker cria um backup por dia. Você também pode gerar um agora mesmo."
              />
            ) : (
              <TableShell
                head={
                  <>
                    <Th role="title">Arquivo</Th>
                    <Th>Tamanho</Th>
                    <Th role="meta" className="text-right">Criado</Th>
                  </>
                }
              >
                {backups.map((backup) => (
                  <tr key={backup.file}>
                    <Td className="font-mono text-[11.5px]">{backup.file.split(/[\\/]/).pop()}</Td>
                    <Td className="num">{formatBytes(backup.bytes)}</Td>
                    <Td className="text-right whitespace-nowrap text-ink-muted">{formatDateTime(backup.createdAt)}</Td>
                  </tr>
                ))}
              </TableShell>
            )}
            <p className="border-t border-line px-4 py-2.5 text-[12px] text-ink-muted">
              Para restaurar: <code className="text-ink">pnpm db:restore &lt;arquivo&gt;</code>. O banco atual é copiado
              antes de ser substituído.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
