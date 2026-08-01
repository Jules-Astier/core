import { BaseProvider } from '@omss/framework';
import type {
    ProviderCapabilities,
    ProviderMediaObject,
    ProviderResult
} from '@omss/framework';

export class FourKHDHubProvider extends BaseProvider {
    readonly id = '4khdhub';
    readonly name = '4KHDHub';
    readonly enabled = process.env.FOURKHDHUB_ENABLED === 'true';
    readonly BASE_URL = 'https://www.4khdhub.store';
    readonly HEADERS = {
        'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150 Safari/537.36',
        Referer: `${this.BASE_URL}/`,
        Origin: this.BASE_URL
    };

    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv']
    };

    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.emptyResult(
            'Provider scaffolded, but 4KHDHub needs a full search/download-link resolver before it can be enabled.'
        );
    }

    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        return this.emptyResult(
            'Provider scaffolded, but 4KHDHub needs a full search/download-link resolver before it can be enabled.'
        );
    }

    private emptyResult(message: string): ProviderResult {
        return {
            sources: [],
            subtitles: [],
            diagnostics: [
                {
                    code: 'PROVIDER_ERROR',
                    message: `${this.name}: ${message}`,
                    field: '',
                    severity: 'error'
                }
            ]
        };
    }

    async healthCheck(): Promise<boolean> {
        try {
            const response = await fetch(this.BASE_URL, {
                method: 'HEAD',
                headers: this.HEADERS
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}
