import { BrowserContext, Page, Stagehand } from "@browserbasehq/stagehand";
import chalk from "chalk";
import dotenv from "dotenv";
import fs from "fs";
import { Parser as Json2CsvParser } from "json2csv";
import { z } from "zod";

import StagehandConfig from "./stagehand.config.js";
import {
  clearOverlays,
  drawObserveOverlay,
  readCache,
  simpleCache,
} from "./utils.js";

dotenv.config();

interface ProjectResult {
  [key: string]: {
    result?: {
      landDetails?: Array<{
        surveyNumber: string;
        field: string;
        value: string;
      }>;
      documents?: Array<{
        category: string;
        documentName: string;
        annexureNumber: string;
        fileName: string;
        downloadUrl: string;
        year?: string;
      }>;
    };
    error?: unknown;
  };
}

export async function main({
  page,
  context,
  stagehand,
}: {
  page: Page;
  context: BrowserContext;
  stagehand: Stagehand;
}) {
  const projectNames = ["birla evara"];

  /**
   * This function is used to act with a cacheable action.
   * It will first try to get the action from the cache.
   * If not in cache, it will observe the page and cache the result.
   * Then it will execute the action.
   * @param page - The page to act on
   * @param instruction - The instruction to act with.
   */
  async function actWithCache(page: Page, instruction: string) {
    // Try to get action from cache first
    const cachedAction = await readCache(instruction);
    if (cachedAction) {
      console.log(chalk.blue("Using cached action for:"), instruction);
      await page.act(cachedAction);
      return;
    }

    // If not in cache, observe the page and cache the result
    const results = await page.observe(instruction);
    console.log(chalk.blue("Got results:"), results);

    // Cache the playwright action
    const actionToCache = results[0];
    console.log(chalk.blue("Taking cacheable action:"), actionToCache);
    await simpleCache(instruction, actionToCache);
    // OPTIONAL: Draw an overlay over the relevant xpaths
    await drawObserveOverlay(page, results);
    await page.waitForTimeout(1000); // Can delete this line, just a pause to see the overlay
    await clearOverlays(page);

    // Execute the action
    await page.act(actionToCache);
  }

  // Process projects in parallel
  const results: ProjectResult[] = await Promise.all(
    projectNames.map(async (projectName, index) => {
      // existing instance for first project
      const currentStagehand =
        index === 0
          ? stagehand
          : new Stagehand({
              ...StagehandConfig,
            });

      if (index > 0) {
        await currentStagehand.init();
      }

      try {
        const result = await extractReraDetails({
          page: currentStagehand.page,
          actWithCache: (instruction) =>
            actWithCache(currentStagehand.page, instruction),
          projectName,
        });
        return {
          [`${projectName}`]: {
            result,
          },
        };
      } catch (error) {
        console.error(chalk.red(`Error processing ${projectName}:`), error);
        return { [projectName]: { error } };
      } finally {
        // close additional instances, not the original one
        if (index > 0) {
          await currentStagehand.close();
        }
      }
    })
  );

  // Transform and save results
  await Promise.all(
    results.map(async (result) => {
      const projectName = Object.keys(result)[0];

      if (!result[projectName]?.error) {
        const baseFileName = projectName.toLowerCase().replace(/\s+/g, "_");
        const jsonPath = `scraped_data/json/${baseFileName}_land_details.json`;
        const csvPath = `scraped_data/csv/${baseFileName}_land_details.csv`;
        const documentsJsonPath = `scraped_data/json/${baseFileName}_documents.json`;
        const documentsCsvPath = `scraped_data/csv/${baseFileName}_documents.csv`;

        try {
          // Ensure directories exist
          await fs.promises.mkdir("scraped_data/json", { recursive: true });
          await fs.promises.mkdir("scraped_data/csv", { recursive: true });

          // Save JSON for land details
          await fs.promises.writeFile(
            jsonPath,
            JSON.stringify(result[projectName].result?.landDetails, null, 2)
          );
          console.log(chalk.green(`Saved JSON results to ${jsonPath}`));

          // Transform land details for CSV
          const landDetails = result[projectName].result?.landDetails;
          if (landDetails && landDetails.length > 0) {
            const surveyGroups = new Map<string, Record<string, string>>();

            // Group by survey number
            landDetails.forEach((detail) => {
              if (!surveyGroups.has(detail.surveyNumber)) {
                surveyGroups.set(detail.surveyNumber, {});
              }
              const group = surveyGroups.get(detail.surveyNumber)!;
              group[detail.field] = detail.value;
            });

            // Convert to CSV format
            const csvData = Array.from(surveyGroups.entries()).map(
              ([surveyNumber, fields]) => ({
                "Survey Number": surveyNumber,
                ...fields,
              })
            );

            // Create CSV with all fields as columns
            const json2csvParser = new Json2CsvParser();
            const csv = json2csvParser.parse(csvData);

            await fs.promises.writeFile(csvPath, csv);
            console.log(chalk.green(`Saved CSV results to ${csvPath}`));
          }

          // Save JSON for documents
          const documents = result[projectName].result?.documents;
          if (documents && documents.length > 0) {
            await fs.promises.writeFile(
              documentsJsonPath,
              JSON.stringify(documents, null, 2)
            );
            console.log(
              chalk.green(`Saved JSON results to ${documentsJsonPath}`)
            );

            // Create CSV for documents
            const json2csvParser = new Json2CsvParser();
            const csv = json2csvParser.parse(documents);

            await fs.promises.writeFile(documentsCsvPath, csv);
            console.log(
              chalk.green(`Saved CSV results to ${documentsCsvPath}`)
            );
          }
        } catch (error) {
          console.error(
            chalk.red(`Error saving results for ${projectName}:`),
            error
          );
        }
      }
    })
  );

  return results;
}

async function extractReraDetails({
  page,
  actWithCache,
  projectName,
}: {
  page: Page;
  actWithCache: (instruction: string) => Promise<void>;
  projectName: string;
}) {
  // Navigate to the page
  await page.goto("https://rera.karnataka.gov.in/viewAllProjects", {
    timeout: 600000,
  });

  await actWithCache(
    `Enter text '${projectName}' in the project name input field`
  );

  await actWithCache("Press the down arrow key");

  await actWithCache("Click the search button");

  await page.waitForLoadState("networkidle");

  await actWithCache("Click the view project details icon button");

  await page.waitForLoadState("networkidle");

  try {
    await page.waitForSelector("text=Land Details", { timeout: 5000 });
  } catch (e) {
    // Retry clicking if details didn't load
    await actWithCache("Click the view project details icon button");
    await page.waitForLoadState("networkidle");
  }

  await actWithCache("Click the Land Details tab");
  await actWithCache("Make sure you are on the Land Details tab");

  const landDetailsSchema = z.array(
    z.object({
      surveyNumber: z.string(),
      field: z.string(),
      value: z.string(),
    })
  );

  const landDetails = await page.extract({
    instruction: `
    For each survey number, extract all the fields listed below as separate entries.
    Each entry should have:
    - The survey number it belongs to
    - The field name
    - The field value
    
    If a field value is not present, use "not available".

    Field list for extraction:
    - Survey Number
    - Type of Land
    - Tenure of Land
    - No. of Land Owners
    - Extent of Land
    - Guidance Value
    - RTC (Annexure-43)
    - Mutation (Annexure-44)
    - Encumbrance Certificate (Annexure-46)
    - Is Conversion/Alienation Done?
    - Conversion/Alienation Order Number
    - Conversion/Alienation Date
    - Conversion/Alienation Authority
    - Conversion/Alienation Type 
    - Conversion/Alienation Order (Annexure-40)
    - Extent of Land as per Conversion/Alienation
    - Is Sale/Title/Gift Deed Executed?
    - Sale Deed Number
    - Deed Execution Date
    - Sub Registrar Office (for Deed)
    - Sale/Title/Gift Deed (Annexure-41)
    - Extent of Land as per Deed
    - Deed Executed From
    - Deed Executed To
    - Is JDA Registered?
    - JDA Registered Date
    - Sub Registrar Office (for JDA)
    - JDA (Annexure-42)
    - Extent of Land as per JDA
    - Khatha Number
    - Khatha Date
    - Khatha Issuing Authority
    - Type of Khatha
    - Extent of Land as per Khatha
    - Khatha (Annexure-45)
    - Land Owner Name
    - Land Owner Share
    - Present Address
    - Communication Address
    `,
    schema: z.object({
      landDetails: landDetailsSchema,
    }),
    useTextExtract: true,
  });

  console.log("LAND DETAILS BELOW " + projectName);
  console.log(landDetails.landDetails);

  try {
    await page.waitForSelector("text=Uploaded Documents", { timeout: 5000 });
  } catch (e) {
    // Retry clicking if details didn't load
    await actWithCache("Click the view project details icon button");
    await page.waitForLoadState("networkidle");
  }

  await actWithCache("Click the Uploaded Documents tab");
  await actWithCache("Make sure you are on the Uploaded Documents tab");

  // First extract documents data without URLs
  const documentsSchema = z.array(
    z.object({
      category: z.string(),
      documentName: z.string(),
      annexureNumber: z.string(),
      fileName: z.string(),
    })
  );

  const documentsData = await page.extract({
    instruction: `
    Extract document information from each category section. Focus on metadata only, not URLs.

    Each document entry should have:
    - category (section name like "Financial Documents", "Project Documents", etc.)
    - documentName (e.g. "Balance Sheet", "Commencement Certificate")
    - annexureNumber (number from "Annexure - XX", find the specific number for each document)
    - fileName (PDF filename or "Not Available.pdf")

    Categories to check:
    - Financial Documents
    - Project Documents
    - Declarations
    - NOC Documents
    - Project Photo
    - Other Documents
    `,
    schema: z.object({
      documents: documentsSchema,
    }),
    useTextExtract: true,
  });

  // Then extract all document links separately
  const documentLinks = await page.extract({
    instruction: `
    Extract all document download links.
    For each link, provide:
    - text: The visible text or filename associated with the link
    - url: The full download URL from href attribute
    
    Look for elements with href containing "/download_jc?DOC_ID="
    For each match, construct the full URL as "https://rera.karnataka.gov.in/download_jc?DOC_ID=<id>"
    `,
    schema: z.object({
      links: z.array(
        z.object({
          text: z.string(),
          url: z.string(),
        })
      ),
    }),
    useTextExtract: false,
  });

  console.log("DOCUMENT LINKS BELOW " + projectName);
  console.log(documentLinks.links);

  // Match URLs with documents based on fileName
  const documents = {
    documents: documentsData.documents.map((doc) => {
      const matchingLink = documentLinks.links.find(
        (link) =>
          link.text.includes(doc.fileName) || doc.fileName.includes(link.text)
      );
      return {
        ...doc,
        downloadUrl: matchingLink?.url || "not available",
      };
    }),
  };

  console.log("DOCUMENTS BELOW " + projectName);
  console.log(documents.documents);

  return {
    landDetails: landDetails.landDetails,
    documents: documents.documents,
  };
}
