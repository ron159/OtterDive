import type { ISyntaxRenderOptions, MarkToken } from '../types';
import type Renderer from './index';

export default function mark(this: Renderer, options: ISyntaxRenderOptions & { token: MarkToken }) {
    return this.delEmStrongFac('mark', options);
}
