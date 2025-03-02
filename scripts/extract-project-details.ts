import { BrowserContext, Page, Stagehand } from "@browserbasehq/stagehand";
import chalk from "chalk";
import dotenv from "dotenv";
import fs from "fs";
import { z } from "zod";

import StagehandConfig from "../stagehand.config.js";
import {
  clearOverlays,
  drawObserveOverlay,
  readCache,
  simpleCache,
} from "../utils.js";

dotenv.config();

interface ProjectResult {
  [key: string]: {
    result?: {
      projectDetails?: {
        projectName: string;
        projectDescription: string;
        projectType: string;
        projectSubType: string;
        projectAddress: string;
        projectLandArea: string;
        projectCoveredArea: string;
        projectAuthority: string;
        projectNames: string;
        farSanctioned: string;
        listOfRegistrationsExtensions: Array<{
          name: string;
          startDate: string;
          completionDate: string;
        }>;
      };
      complaints?: Array<{
        complaintDate: string;
        complaintSubject: string;
      }>;
    };
    error?: unknown;
  };
}

export async function extractProjectDetails({
  page,
  context,
  stagehand,
}: {
  page: Page;
  context: BrowserContext;
  stagehand: Stagehand;
}) {
  const registrationNo = ["PRM/KA/RERA/1251/446/PR/060225/007487"];

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
    registrationNo.map(async (rn, index) => {
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
          registrationNo: rn,
        });
        return {
          [`${rn}`]: {
            result,
          },
        };
      } catch (error) {
        console.error(chalk.red(`Error processing ${rn}:`), error);
        return { [rn]: { error } };
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

      const dirPath = `scraped_data/json`;

      const jsonPath = `project_details.json`;

      try {
        // Ensure nested directory structure exists
        await fs.promises.mkdir(dirPath, { recursive: true });

        // Save JSON for project details and complaints
        await fs.promises.writeFile(
          jsonPath,
          JSON.stringify(
            {
              projectDetails: result[projectName].result?.projectDetails,
              complaints: result[projectName].result?.complaints,
            },
            null,
            2
          )
        );
        console.log(chalk.green(`Saved JSON results to ${jsonPath}`));
      } catch (error) {
        console.error(
          chalk.red(`Error saving results for ${projectName}:`),
          error
        );
      }
    })
  );

  return results;
}

async function extractReraDetails({
  page,
  actWithCache,
  registrationNo,
}: {
  page: Page;
  actWithCache: (instruction: string) => Promise<void>;
  registrationNo: string;
}) {
  // Navigate to the page
  await page.goto("https://rera.karnataka.gov.in/viewAllProjects", {
    timeout: 600000,
  });

  await actWithCache(
    `Enter text '${registrationNo}' in the "Registration No" input field`
  );

  await actWithCache("Press the down arrow key");

  await actWithCache("Click the search button");

  await page.waitForLoadState("networkidle");

  await actWithCache("Click the View Project Details icon button");

  await page.waitForLoadState("networkidle");

  await page.waitForTimeout(2000);

  // Navigate to project details tab and extract details
  const projectDetails = await extractProjectDetailsData(
    page,
    actWithCache,
    registrationNo
  );

  // Extract Complaints
  const complaints = await extractComplaints(page, actWithCache);

  return {
    projectDetails,
    complaints,
  };
}

async function extractProjectDetailsData(
  page: Page,
  actWithCache: (instruction: string) => Promise<void>,
  registrationNo: string
) {
  await page.waitForSelector("text=Project Details", { timeout: 5000 });

  await actWithCache("Go to Project Details tab");

  // try {
  //   await page.waitForSelector("text=Project Description", { timeout: 5000 });
  // } catch (error) {
  //   await actWithCache("Go to Project Details tab");
  // }

  // Extract all project details including registrations/extensions
  const projectDetailsSchema = z.object({
    projectName: z.string(),
    projectDescription: z.string(),
    projectType: z.string(),
    projectSubType: z.string(),
    projectAddress: z.string(),
    projectLandArea: z.string(),
    projectCoveredArea: z.string(),
    projectAuthority: z.string(),
    projectNames: z.string(),
    farSanctioned: z.string(),
    listOfRegistrationsExtensions: z.array(
      z.object({
        name: z.string(),
        startDate: z.string(),
        completionDate: z.string(),
      })
    ),
  });

  const projectDetails = await page.extract({
    instruction: `Extract these project details, use "not available" if not found:
    - Project Name (Tab field name)
    - Project Description
    - Project Type
    - Project Sub Type
    - Project Address
    - Project Land Area (Total Area Of Land (Sq Mtr) (A1+A2))
    - Project Covered Area (Total Coverd Area (Sq Mtr) (A2))
    - Project Authority (Approving Authority)
    - Project Names (combine contractor names with commas)
    - FAR Sanctioned

    Also extract all registration/extension entries. For each entry include:
    - name (Registration/Extensions)
    - startDate
    - completionDate
    `,
    schema: z.object({
      projectDetails: projectDetailsSchema,
    }),
    useTextExtract: true,
  });

  console.log("PROJECT DETAILS BELOW " + registrationNo);
  console.log(projectDetails.projectDetails);

  return projectDetails.projectDetails;
}

async function extractComplaints(
  page: Page,
  actWithCache: (instruction: string) => Promise<void>
) {
  await actWithCache("Go to Complaints tab");

  try {
    await page.waitForSelector("text=Complaints On this Project", {
      timeout: 5000,
    });
  } catch (error) {
    await actWithCache("Go to Complaints tab");
  }

  await actWithCache("In complaints tab, click on Complaints On this Project");

  const complaintsSchema = z.array(
    z.object({
      complaintDate: z.string(),
      complaintSubject: z.string(),
    })
  );

  const complaintsData = await page.extract({
    instruction: `Extract all complaints, for each complaint include:
    - complaintDate (Date of Complaint)
    - complaintSubject (Subject of Complaint)`,
    schema: z.object({
      complaints: complaintsSchema,
    }),
    useTextExtract: true,
  });

  console.log(complaintsData.complaints);

  return complaintsData.complaints;
}
