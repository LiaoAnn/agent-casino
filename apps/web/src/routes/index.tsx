import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  return <h1 className="font-semibold text-2xl">排行榜</h1>;
}
