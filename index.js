const fs = require('fs');
const path = require("path");
const mime = require("mime-types");
const core = require('@actions/core');
const AWS = require('aws-sdk');
const cloudfront = new AWS.CloudFront();
const s3 = new AWS.S3();

async function get_distribution_id(s3_name) {
    const DistributionList = await cloudfront.listDistributions().promise();
    for (let distribution of DistributionList.Items) {
        if (distribution.Aliases.Items.includes(s3_name)) {
            console.log("The distribution was found.");
            return distribution['Id'];
        }
    }
    console.log("Failed to find the distribution for this bucket.");
    process.exit(1);
}

async function invalidation(distribution_ID, paths) {
    const params = {
        DistributionId: distribution_ID.toString(),
        InvalidationBatch: {
            CallerReference: `${+new Date()}`,
            Paths: {
                Quantity: paths.length,
                Items: paths
            }
        }
    }
    const invalidation_request = await cloudfront.createInvalidation(params).promise();
    const wait_params = {
        DistributionId: distribution_ID.toString(),
        Id: invalidation_request['Invalidation']['Id'].toString()
    };
    cloudfront.waitFor('invalidationCompleted', wait_params, function(err, data) {
        if (err) {
            console.log(err, err.stack);
            process.exit(1);
        } else {
            console.log(data);
        }
    });
}

function upload_to_s3(s3_name, build_folder_path) {
    const dirName = path.basename(build_folder_path);
    console.info(dirName);
    function walkSync(currentDirPath, callback) {
        fs.readdirSync(currentDirPath).forEach(function (name) {
            const filePath = path.join(currentDirPath, name);
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
                callback(filePath, stat);
            } else if (stat.isDirectory()) {
                walkSync(filePath, callback);
            }
        });
    }
    walkSync(build_folder_path, function (filePath) {
        if (filePath.endsWith("/")) {
            return;
        }
        const bucketPath = `${filePath.split(dirName)[1].replace('/','')}`;
        const params = {
            Bucket: s3_name,
            Key: bucketPath,
            Body: fs.readFileSync(filePath),
            ContentType: mime.lookup(bucketPath) || "text/plain",
        };

        const uploadLog = bucketPath + " Type:" + params.ContentType;

        s3.putObject(params, function (err) {
            if (err) {
                console.error(err.message);
            } else {
                console.info(`Uploaded: ${uploadLog}`);
            }
        });
    });
}

const s3_name = core.getInput('s3-bucket-name');
const build_folder_path = core.getInput('build-folder-path');
upload_to_s3(s3_name, build_folder_path)
get_distribution_id(s3_name).then(result => {
    invalidation(result, ['/*']).then()
})