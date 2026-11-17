import { PageIntro } from '@/components/PageIntro/PageIntro';

/*
 * The costs page's intro band. The band, its hide control and the shared `hsr_intro_hidden` key live in
 * `components/PageIntro` since S14.3a (the team builder has the same band); this file keeps the costs wording.
 */

export { INTRO_KEY } from '@/components/PageIntro/PageIntro';

export function CostsIntro({ onToggle }: { onToggle?: () => void }) {
    return (
        <PageIntro
            title={
                <>
                    The <em>cost</em> of every pick.
                </>
            }
            collapsedTitle="Cost Tables"
            onToggle={onToggle}
        >
            Each unit and light cone carries a cost that scales with eidolon and superimposition.
            Flip the <strong>draft mode</strong> and <strong>game mode</strong> to see how the
            ledger shifts. Classic budgets are fixed; Auction values seed the opening bid.
        </PageIntro>
    );
}
