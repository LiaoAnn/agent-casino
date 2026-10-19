import { createRouter } from '@tanstack/react-router';
import { PageError } from './components/notice';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  return createRouter({ routeTree, defaultErrorComponent: PageError });
}
