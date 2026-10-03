// Compatibility entry: packaging never replaces an installed/running application.
import { packagePlatform } from './package-platform.mjs';
const result = await packagePlatform();
console.log(JSON.stringify(result));
