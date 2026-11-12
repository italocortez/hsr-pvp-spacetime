import { createFileRoute } from '@tanstack/react-router';
import { StandbyPage } from '@/pages/standby/StandbyPage';

export const Route = createFileRoute('/_admin/admin')({
    component: () => <StandbyPage module="Admin Console" />,
});
