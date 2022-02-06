const { execSync } = require('child_process');
const core = require('@actions/core');

function deploy_to_cloudfront(s3_name, build_folder_path) {
    let distrib_id;
    try {
        execSync("aws configure set preview.cloudfront true");
        const distrib_id_request = 'aws cloudfront list-distributions' +
            ' --output text --query "DistributionList.Items[?Origins.Items[0].DomainName==\'' +
            s3_name + '.s3.eu-central-1.amazonaws.com\'].Id"'
        distrib_id = execSync(distrib_id_request).toString().replace(/\r?\n|\r/g, "");
        console.log("The distribution was found");
    } catch (error) {
        console.log("Failed to find the distribution for this bucket.");
        process.exit(1);
    }
    try {
        const sync_request = 'aws s3 sync ' + build_folder_path + ' s3://' +
            s3_name + '/'
        execSync(sync_request);
        console.log("Files were synced");
    } catch (error) {
        console.log("Failed to sync the files to a bucket.");
        process.exit(1);
    }
    try {
        const invalidation_request = 'aws cloudfront' +
            ' create-invalidation --distribution-id ' +
            distrib_id + ' --paths "/*"'
        console.log(invalidation_request)
        execSync(invalidation_request);
        console.log("Cache was invalidated");
    } catch (error) {
        console.log("Failed to invalidate cache.");
        process.exit(1);
    }
}

const s3_name = core.getInput('s3-bucket-name');
const build_folder_path = core.getInput('build-folder-path');
deploy_to_cloudfront(s3_name, build_folder_path)