import { createFileRoute } from '@tanstack/react-router';
import { StandbyPage } from '@/pages/standby/StandbyPage';

export const Route = createFileRoute('/costs')({
    component: () => <StandbyPage module="Cost Tables" />,
});
