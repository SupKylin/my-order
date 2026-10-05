import { api } from './http';

export const getMetadata = () => api.get('/meta', { silent: true });
